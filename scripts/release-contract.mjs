// Shared by the release gates so they cannot disagree about the tool contract.
// The 0.1.5 release failed because the tag-time smoke check carried its own
// copy of the list and never saw the two tools added after it was written.

export function describeContractDrift(expected, actual) {
  const wanted = [...expected].sort();
  const got = [...actual].sort();
  if (JSON.stringify(wanted) === JSON.stringify(got)) return undefined;
  const missing = wanted.filter((name) => !got.includes(name));
  const unexpected = got.filter((name) => !wanted.includes(name));
  const parts = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (unexpected.length > 0) parts.push(`unexpected ${unexpected.join(', ')}`);
  if (parts.length === 0) parts.push(`same names in a different shape: ${got.join(', ')}`);
  return `${parts.join('; ')}. Declared contract: ${wanted.join(', ')}.`;
}
