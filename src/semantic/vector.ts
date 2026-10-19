export function normalizeVector(vector: Float32Array): Float32Array {
  if (!vector.length) throw new Error("Semantic vector must not be empty");
  let squaredNorm = 0;
  for (const value of vector) {
    if (!Number.isFinite(value))
      throw new Error("Semantic vector contains a non-finite value");
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm <= 1e-12)
    throw new Error("Semantic vector has zero magnitude");
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1)
    normalized[index] = vector[index] / norm;
  return normalized;
}

export function encodeVector(vector: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1)
    view.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, vector[index], true);
  return bytes;
}

export function decodeVector(value: unknown, dimensions: number): Float32Array {
  const bytes = toUint8Array(value);
  const expectedBytes = dimensions * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expectedBytes)
    throw new Error(
      `Semantic vector BLOB has ${bytes.byteLength} bytes; expected ${expectedBytes}`,
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1)
    vector[index] = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
  return vector;
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(isByte)) return Uint8Array.from(value);
  throw new Error("Semantic vector value is not a binary BLOB");
}

function isByte(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 255;
}
