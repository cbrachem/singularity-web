// boundary-intent harness: turns doubles into bit patterns for the fixtures, and reaches no rule
/**
 * Doubles as their IEEE-754 bit patterns, so a floating-point value crosses between the
 * fixtures and the tests without a decimal literal rounding it on the way.
 */

const view = new DataView(new ArrayBuffer(8));

export function doubleToBits(value: number): bigint {
  view.setFloat64(0, value);
  return view.getBigUint64(0);
}

export function bitsToDouble(value: bigint): number {
  view.setBigUint64(0, value);
  return view.getFloat64(0);
}

export function formatBits(value: bigint): string {
  return value.toString(16).padStart(16, "0");
}

export function parseBits(text: string): bigint {
  return BigInt(`0x${text}`);
}

/** FNV-1a over 64-bit patterns, so a whole run of a function compares as one value. */
export function digest(values: readonly bigint[]): string {
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (const value of values) {
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      hash = ((hash ^ ((value >> shift) & 0xffn)) * 0x100000001b3n) & mask;
    }
  }
  return formatBits(hash);
}
