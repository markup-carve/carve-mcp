//! Newline-delimited JSON-RPC over a reader and writer, in place of rmcp's
//! stdio transport.
//!
//! rmcp drops a line that is not valid JSON without a reply, and serde_json's
//! recursion limit of 128 counts as a syntax error, so a request nested deeper
//! than that vanished and its client waited forever. This transport answers
//! unparsable JSON with `-32700`, a request nested past [`MAX_REQUEST_DEPTH`]
//! or of the wrong shape with `-32600`, and parses anything shallower without
//! serde_json's limit.

use std::sync::Arc;

use rmcp::{
    RoleServer,
    service::{RxJsonRpcMessage, TxJsonRpcMessage},
    transport::Transport,
};
use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Mutex;

/// Deepest JSON nesting a request may carry. The parser bounds a Carve tree
/// well below this, and a deeper `Value` would be dropped recursively.
pub const MAX_REQUEST_DEPTH: usize = 2048;

/// Longest request line accepted, matching the 10 MB the Node SDK buffers.
const MAX_LINE_BYTES: usize = 10 * 1024 * 1024;

pub struct LineTransport<R, W> {
    read: BufReader<R>,
    write: Arc<Mutex<W>>,
    // Kept across calls: `receive` is polled inside a `select!`, and a
    // cancelled `read_until` leaves its partial line here for the next call.
    line: Vec<u8>,
    // Set while the rest of an over-long line is being discarded.
    oversized: bool,
}

impl<R: AsyncRead + Unpin, W: AsyncWrite + Unpin> LineTransport<R, W> {
    pub fn new(read: R, write: W) -> Self {
        Self {
            read: BufReader::new(read),
            write: Arc::new(Mutex::new(write)),
            line: Vec::new(),
            oversized: false,
        }
    }
}

#[derive(Debug)]
pub struct TransportError(String);

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TransportError {}

/// What a request line turned out to be.
#[derive(Debug)]
enum Line {
    Message(Box<RxJsonRpcMessage<RoleServer>>),
    /// A notification of a shape rmcp does not know; JSON-RPC never answers one.
    Ignored,
    Reply(String),
}

fn error_reply(id: &str, code: i64, message: &str) -> String {
    format!(
        "{{\"jsonrpc\":\"2.0\",\"id\":{id},\"error\":{{\"code\":{code},\"message\":{}}}}}",
        serde_json::Value::from(message)
    )
}

/// JSON container depth of `bytes`, and the raw top-level `"id"` value when
/// one is a string or number. A byte scan: it has no recursion to exhaust.
fn scan(bytes: &[u8]) -> (usize, Option<String>) {
    let mut depth = 0usize;
    let mut deepest = 0usize;
    let mut id = None;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'{' | b'[' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            b'"' => {
                let start = index + 1;
                index += 1;
                while index < bytes.len() && bytes[index] != b'"' {
                    index += if bytes[index] == b'\\' { 2 } else { 1 };
                }
                let end = index.min(bytes.len());
                let mut next = index + 1;
                while next < bytes.len() && bytes[next].is_ascii_whitespace() {
                    next += 1;
                }
                if depth == 1
                    && id.is_none()
                    && &bytes[start..end] == b"id"
                    && bytes.get(next) == Some(&b':')
                {
                    id = raw_scalar(&bytes[next + 1..]);
                }
            }
            _ => {}
        }
        index += 1;
    }
    (deepest, id)
}

fn raw_scalar(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?.trim_start();
    let mut stream = serde_json::Deserializer::from_str(text).into_iter::<serde_json::Value>();
    match stream.next()?.ok()? {
        value @ (serde_json::Value::String(_) | serde_json::Value::Number(_)) => {
            Some(value.to_string())
        }
        _ => None,
    }
}

fn classify(line: &[u8]) -> Line {
    let (depth, id) = scan(line);
    let id = id.as_deref().unwrap_or("null");
    if depth > MAX_REQUEST_DEPTH {
        return Line::Reply(error_reply(
            id,
            -32600,
            &format!("Invalid Request: JSON nests deeper than {MAX_REQUEST_DEPTH} levels."),
        ));
    }
    let mut deserializer = serde_json::Deserializer::from_slice(line);
    deserializer.disable_recursion_limit();
    let parsed = RxJsonRpcMessage::<RoleServer>::deserialize(serde_stacker::Deserializer::new(
        &mut deserializer,
    ))
    .and_then(|message| deserializer.end().map(|()| message));
    match parsed {
        Ok(message) => Line::Message(Box::new(message)),
        Err(error) => match error.classify() {
            serde_json::error::Category::Syntax | serde_json::error::Category::Eof => {
                Line::Reply(error_reply("null", -32700, "Parse error"))
            }
            _ => {
                let mut deserializer = serde_json::Deserializer::from_slice(line);
                deserializer.disable_recursion_limit();
                let value = serde_json::Value::deserialize(serde_stacker::Deserializer::new(
                    &mut deserializer,
                ))
                .unwrap_or_default();
                if value.get("method").is_some() && value.get("id").is_none() {
                    Line::Ignored
                } else {
                    Line::Reply(error_reply(id, -32600, "Invalid Request"))
                }
            }
        },
    }
}

impl<R, W> Transport<RoleServer> for LineTransport<R, W>
where
    R: AsyncRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send + 'static,
{
    type Error = TransportError;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send + 'static {
        let write = self.write.clone();
        async move {
            let mut bytes =
                serde_json::to_vec(&item).map_err(|error| TransportError(error.to_string()))?;
            bytes.push(b'\n');
            let mut write = write.lock().await;
            write
                .write_all(&bytes)
                .await
                .map_err(|error| TransportError(error.to_string()))?;
            write
                .flush()
                .await
                .map_err(|error| TransportError(error.to_string()))
        }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        loop {
            // Bounded: an oversized line is dropped as it streams in, never
            // buffered whole, and answered once its newline arrives.
            let available = match self.read.fill_buf().await {
                Ok([]) | Err(_) => return None,
                Ok(bytes) => bytes,
            };
            let Some(end) = available.iter().position(|byte| *byte == b'\n') else {
                let length = available.len();
                if !self.oversized && self.line.len() + length > MAX_LINE_BYTES {
                    self.oversized = true;
                    self.line = Vec::new();
                }
                if !self.oversized {
                    self.line.extend_from_slice(available);
                }
                self.read.consume(length);
                continue;
            };
            if !self.oversized && self.line.len() + end > MAX_LINE_BYTES {
                self.oversized = true;
                self.line = Vec::new();
            }
            if !self.oversized {
                self.line.extend_from_slice(&available[..end]);
            }
            self.read.consume(end + 1);
            let outcome = if std::mem::take(&mut self.oversized) {
                Line::Reply(error_reply(
                    "null",
                    -32600,
                    &format!("Invalid Request: the message exceeds {MAX_LINE_BYTES} bytes."),
                ))
            } else {
                let mut line = self.line.as_slice();
                line = line.strip_suffix(b"\r").unwrap_or(line);
                line = line.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(line);
                if line.iter().all(u8::is_ascii_whitespace) {
                    Line::Ignored
                } else {
                    classify(line)
                }
            };
            self.line.clear();
            match outcome {
                Line::Message(message) => return Some(*message),
                Line::Ignored => {}
                Line::Reply(reply) => {
                    let mut write = self.write.lock().await;
                    let written = write.write_all(format!("{reply}\n").as_bytes()).await;
                    if written.is_err() || write.flush().await.is_err() {
                        return None;
                    }
                }
            }
        }
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self.write
            .lock()
            .await
            .shutdown()
            .await
            .map_err(|error| TransportError(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(line: &str) -> serde_json::Value {
        match classify(line.as_bytes()) {
            Line::Reply(reply) => serde_json::from_str(&reply).unwrap(),
            other => panic!("expected a reply, got {other:?}"),
        }
    }

    #[test]
    fn malformed_json_gets_a_parse_error() {
        let error = reply("{\"jsonrpc\":\"2.0\",\"id\":1,");
        assert_eq!(error["error"]["code"], -32700);
        assert_eq!(error["id"], serde_json::Value::Null);
        assert_eq!(reply("not json")["error"]["code"], -32700);
    }

    #[test]
    fn a_request_deeper_than_serde_json_allows_still_parses() {
        let nested = format!("{}1{}", "[".repeat(200), "]".repeat(200));
        let line = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{{\"name\":\"carve_lint\",\"arguments\":{{\"source\":\"x\",\"extra\":{nested}}}}}}}"
        );
        assert!(matches!(classify(line.as_bytes()), Line::Message(_)));
    }

    #[test]
    fn a_request_past_the_depth_limit_is_answered_with_its_id() {
        let nested = format!(
            "{}1{}",
            "[".repeat(MAX_REQUEST_DEPTH + 1),
            "]".repeat(MAX_REQUEST_DEPTH + 1)
        );
        let line = format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":\"deep\",\"method\":\"tools/call\",\"params\":{nested}}}"
        );
        let error = reply(&line);
        assert_eq!(error["error"]["code"], -32600);
        assert_eq!(error["id"], "deep");
    }

    #[test]
    fn a_wrong_shape_is_an_invalid_request_and_an_unknown_notification_is_ignored() {
        let error = reply("{\"jsonrpc\":\"2.0\",\"id\":3}");
        assert_eq!(error["error"]["code"], -32600);
        assert_eq!(reply("[1]")["error"]["code"], -32600);
        assert!(matches!(
            classify(b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/unknown\",\"params\":5}"),
            Line::Ignored
        ));
    }

    #[tokio::test]
    async fn the_transport_answers_garbage_and_keeps_reading() {
        let (client, server) = tokio::io::duplex(1 << 20);
        let (server_read, server_write) = tokio::io::split(server);
        let mut transport = LineTransport::new(server_read, server_write);
        let (client_read, mut client_write) = tokio::io::split(client);
        client_write
            .write_all(b"garbage\n{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n")
            .await
            .unwrap();
        let message = transport
            .receive()
            .await
            .expect("the valid request arrives");
        assert!(
            format!("{message:?}").contains("PingRequest"),
            "{message:?}"
        );
        let mut lines = BufReader::new(client_read).lines();
        let first: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(first["error"]["code"], -32700);
    }

    #[tokio::test]
    async fn an_oversized_line_is_discarded_while_streaming_and_answered() {
        let (client, server) = tokio::io::duplex(1 << 16);
        let (server_read, server_write) = tokio::io::split(server);
        let mut transport = LineTransport::new(server_read, server_write);
        let (client_read, mut client_write) = tokio::io::split(client);
        let writer = tokio::spawn(async move {
            let chunk = vec![b'x'; 1 << 20];
            for _ in 0..=(MAX_LINE_BYTES >> 20) {
                client_write.write_all(&chunk).await.unwrap();
            }
            client_write
                .write_all(b"\n{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n")
                .await
                .unwrap();
            client_write
        });
        let receiving = tokio::spawn(async move {
            let message = transport.receive().await;
            (message, transport.line.capacity())
        });
        let mut lines = BufReader::new(client_read).lines();
        let first: serde_json::Value =
            serde_json::from_str(&lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(first["error"]["code"], -32600);
        let (message, capacity) = receiving.await.unwrap();
        assert!(format!("{message:?}").contains("PingRequest"));
        assert!(capacity <= MAX_LINE_BYTES, "buffered {capacity} bytes");
        drop(writer.await.unwrap());
    }
}
