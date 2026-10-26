export function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
