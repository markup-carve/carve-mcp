//! Workspace edit receipt and project scan guards.
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{collections::BTreeMap, io::Read, sync::OnceLock};
use crate::{blocks::sha256_text, workspace::Workspace};

type HmacSha256 = Hmac<Sha256>;
fn key() -> &'static [u8;32] {
    static KEY: OnceLock<[u8;32]> = OnceLock::new();
    KEY.get_or_init(|| { let mut key=[0u8;32]; std::fs::File::open("/dev/urandom")
        .and_then(|mut file|file.read_exact(&mut key)).expect("host random source"); key })
}
fn signature(value:&Value)->String {
    let mut mac=HmacSha256::new_from_slice(key()).expect("HMAC key length");
    mac.update(value.to_string().as_bytes());
    hex(&mac.finalize().into_bytes())
}
fn hex(bytes:&[u8])->String {bytes.iter().map(|byte|format!("{byte:02x}")).collect()}
fn canonical_path(path:&str)->Result<String,String> {
    let mut parts=Vec::new();
    let normalized = path.replace('\\',"/");
    for part in normalized.split('/') {
        match part {""|"."=>{},".."=>{parts.pop().ok_or("Path escapes the root")?;},_=>parts.push(part)}
    }
    Ok(parts.join("/"))
}
fn review(workspace:&Workspace,root:usize,path:&str,source:Option<&str>)->Result<Value,String> {
    workspace.review_with_replacement(root,workspace.review_max_depth(),workspace.review_limit(),
        workspace.review_github(),true,true,source.map(|source|(path,source)))
}
fn complete(value:&Value,path:&str)->Result<(),String> {
    if !value["filesRead"].as_array().is_some_and(|files|files.iter().any(|file|file==path)) {
        return Err("The edited file is outside the workspace review scope.".into());
    }
    if value["truncated"]==true || value["projectWarnings"].as_array().is_some_and(|warnings|warnings.iter().any(|w|w["rule"]=="unreadable-document")) {
        return Err("The workspace scan is incomplete; the edit cannot be reviewed.".into());
    }
    Ok(())
}
fn warning_key(value:&Value, include_severity:bool)->String {
    let parts=[value["rule"].as_str().unwrap_or(""),value["path"].as_str().unwrap_or(""),
        value["target"].as_str().unwrap_or(""),value["message"].as_str().unwrap_or("")];
    let mut key=parts.join("\0");
    if include_severity {key.push('\0');key.push_str(value["severity"].as_str().unwrap_or(""));}
    key
}
fn new_errors(before:&Value,after:&Value,include_severity:bool)->Vec<Value> {
    let mut counts=BTreeMap::<String,usize>::new();
    for warning in before["projectWarnings"].as_array().into_iter().flatten() {
        *counts.entry(warning_key(warning,include_severity)).or_default()+=1;
    }
    after["projectWarnings"].as_array().into_iter().flatten().filter(|warning| {
        let count=counts.entry(warning_key(warning,include_severity)).or_default();
        if *count>0 {*count-=1; false} else {warning["severity"]=="error"}
    }).cloned().collect()
}
pub(crate) fn project(workspace:&Workspace,root:usize,path:&str,result:&str)
    ->Result<(String,Value,Value,Value),String> {
    let path=canonical_path(path)?;
    let before=review(workspace,root,&path,None)?;
    let after=review(workspace,root,&path,Some(result))?;
    complete(&before,&path)?; complete(&after,&path)?;
    let introduced=new_errors(&before,&after,false);
    if !introduced.is_empty() {return Err(format!("The edit introduces project validation errors: {}", introduced.len()));}
    let project=json!({"filesRead":after["filesRead"],"includeDependencies":after["includeDependencies"],
        "includeAdjustments":after["includeAdjustments"].as_array().cloned().unwrap_or_default(),
        "introduced":introduced,"existing":after["projectWarnings"],"complete":after["checks"]["complete"]});
    Ok((path,project,before,after))
}
pub(crate) fn receipt(root:usize,path:&str,expected:&str,original:&str,undo_patch:&Value,before:&Value)->String {
    let warnings:Vec<Value>=before["projectWarnings"].as_array().into_iter().flatten().map(|warning| {
        let mut row=json!({"rule":warning["rule"],"path":warning["path"],"message":warning["message"],"severity":warning["severity"]});
        if let Some(target)=warning["target"].as_str(){row["target"]=json!(target);} row
    }).collect();
    let mut payload=json!({"rootIndex":root,"path":path,"expectedSha256":expected,
        "originalSha256":original,"undoPatch":undo_patch,"originalProjectWarnings":warnings});
    let signed=signature(&payload);payload["signature"]=json!(signed);payload.to_string()
}
pub(crate) fn undo(workspace:&Workspace,receipt:&str)->Result<Value,String> {
    if !workspace.allow_write(){return Err("Workspace writes are disabled.".into());}
    let mut value:Value=serde_json::from_str(receipt).map_err(|_|"The undo receipt is invalid.".to_string())?;
    let provided=value["signature"].as_str().unwrap_or("").to_string();
    value.as_object_mut().ok_or("The undo receipt is invalid.")?.remove("signature");
    let expected=signature(&value);
    if provided.len()!=expected.len() || !constant_time_eq(provided.as_bytes(),expected.as_bytes()) {
        return Err("The undo receipt is invalid or belongs to another server process.".into());
    }
    let root=value["rootIndex"].as_u64().ok_or("Invalid undo root")? as usize;
    let path=value["path"].as_str().ok_or("Invalid undo path")?;
    let expected_hash=value["expectedSha256"].as_str().ok_or("Invalid undo hash")?;
    let original_hash=value["originalSha256"].as_str().ok_or("Invalid original hash")?;
    let current=workspace.read(root,path)?;
    if current["sha256"]!=expected_hash {return Err("The source changed after the edit.".into());}
    let edits=value["undoPatch"]["edits"].as_array().ok_or("The undo patch is invalid.")?;
    if edits.len()!=1{return Err("The undo patch is invalid.".into());}
    let start=edits[0]["start"].as_u64().ok_or("The undo patch is invalid.")? as usize;
    let end=edits[0]["end"].as_u64().ok_or("The undo patch is invalid.")? as usize;
    let replacement=edits[0]["replacement"].as_str().ok_or("The undo patch is invalid.")?;
    let source=current["content"].as_str().ok_or("The source changed after the edit.")?;
    if end<start || end>source.len() || !source.is_char_boundary(start) || !source.is_char_boundary(end) {return Err("The undo patch is invalid.".into());}
    let restored=format!("{}{}{}",&source[..start],replacement,&source[end..]);
    if sha256_text(&restored)!=original_hash {return Err("The undo patch does not restore the previewed source.".into());}
    let before=review(workspace,root,path,None)?;let after=review(workspace,root,path,Some(&restored))?;
    complete(&before,path)?;complete(&after,path)?;
    let introduced=new_errors(&before,&after,true);
    if !introduced.is_empty(){return Err("Undo would introduce project errors.".into());}
    workspace.write(root,path,&restored,Some(expected_hash),false)
}
fn constant_time_eq(a:&[u8],b:&[u8])->bool {
    if a.len()!=b.len(){return false;} let mut delta=0u8;
    for (a,b) in a.iter().zip(b){delta|=a^b;} delta==0
}
