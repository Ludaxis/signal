// @vitest-environment node
// RFC 8785 (JCS) canonicaliser against the RFC's own examples, and (key order never changes the object hash).
import './guard';
import { describe, expect, it } from 'vitest';
import { canonicalBytes, canonicalize, hashJson, putJson } from '@/lib/studio/postmaker/store/objects';
import { tmp } from './guard';

const fromHex = (hex: string) => {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setBigUint64(0, BigInt(`0x${hex}`));
  return dv.getFloat64(0);
};

describe('RFC 8785 canonicalisation', () => {
  it('reproduces the sample input → output', () => {
    // Built from code points so the JSON text is byte-for-byte the RFC's (escapes and all).
    const bs = String.fromCharCode(92);
    const u = (h: string) => `${bs}u${h}`;
    const input =
      '{\n  "numbers": [333333333.33333329, 1E30, 4.50,\n              2e-3, 0.000000000000000000000000001],\n' +
      `  "string": "${u('20ac')}$${u('000F')}${u('000a')}A'${u('0042')}${u('0022')}${u('005c')}${bs}${bs}${bs}"${bs}/",\n` +
      '  "literals": [null, true, false]\n}';
    const euro = String.fromCharCode(0x20ac);
    const expected = `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${euro}$${bs}u000f${bs}nA'B${bs}"${bs}${bs}${bs}${bs}${bs}"/"}`;
    expect(canonicalize(JSON.parse(input))).toBe(expected);
  });

  it('the UTF-8 bytes of the sample output', () => {
    const hex = `7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72
      75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a
      5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31
      65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37
      5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30
      30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d`.split(/\s+/).join('');
    const value = { numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27], string: "€$\u000f\nA'B\"\\\\\"/", literals: [null, true, false] };
    expect(canonicalBytes(value).toString('hex')).toBe(hex);
  });

  it('sorts properties by UTF-16 code units', () => {
    const input = String.raw`{
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis"
    }`;
    const expected =
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}';
    expect(canonicalize(JSON.parse(input))).toBe(expected);
  });

  it('Appendix B: number serialisation', () => {
    const cases: [string, string][] = [
      ['0000000000000000', '0'],
      ['8000000000000000', '0'],
      ['0000000000000001', '5e-324'],
      ['8000000000000001', '-5e-324'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
      ['3eb0c6f7a0b5ed8d', '0.000001'],
      ['41b3de4355555553', '333333333.3333332'],
      ['41b3de4355555554', '333333333.33333325'],
      ['41b3de4355555555', '333333333.3333333'],
      ['41b3de4355555556', '333333333.3333334'],
      ['41b3de4355555557', '333333333.33333343'],
      ['becbf647612f3696', '-0.0000033333333333333333'],
      ['43143ff3c1cb0959', '1424953923781206.2'],
    ];
    for (const [hex, text] of cases) expect([hex, canonicalize(fromHex(hex))]).toEqual([hex, text]);
  });

  it('Appendix B: NaN and Infinity are errors', () => {
    expect(() => canonicalize(fromHex('7fffffffffffffff'))).toThrow(/finite/);
    expect(() => canonicalize(fromHex('7ff0000000000000'))).toThrow(/finite/);
    expect(() => canonicalize({ a: -Infinity })).toThrow(/finite/);
  });

  it('refuses lone surrogates (I-JSON), BigInt and cycles; drops undefined like JSON', () => {
    expect(() => canonicalize({ a: '\ud800' })).toThrow(/surrogate/);
    expect(() => canonicalize({ ['\udc00']: 1 })).toThrow(/surrogate/);
    expect(() => canonicalize({ a: BigInt(1) })).toThrow(/BigInt/);
    const c: Record<string, unknown> = {};
    c.self = c;
    expect(() => canonicalize(c)).toThrow(/Circular/);
    expect(canonicalize({ b: undefined, a: [undefined, 1] })).toBe('{"a":[null,1]}');
    expect(canonicalize({ d: new Date('2026-11-06T00:00:00.000Z') })).toBe('{"d":"2026-11-06T00:00:00.000Z"}');
  });
});

describe('same JSON, different key order → one object, one hash', () => {
  it('stores one object for shuffled inputs', async () => {
    const a = { schema: 'x', b: [1, { y: 2, x: 1 }], a: { d: 'fa', c: 'ابر' }, n: 1.5 };
    const b = { n: 1.5, a: { c: 'ابر', d: 'fa' }, b: [1, { x: 1, y: 2 }], schema: 'x' };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(hashJson(a)).toBe(hashJson(b));
    const p1 = await putJson(tmp.root, a);
    const p2 = await putJson(tmp.root, b);
    expect(p1.sha256).toBe(p2.sha256);
    expect(p1.sha256).toBe(hashJson(a));
    expect(p1.existed).toBe(false);
    expect(p2.existed).toBe(true);
  });

  it('array order is significant', () => {
    expect(hashJson([1, 2])).not.toBe(hashJson([2, 1]));
  });
});
