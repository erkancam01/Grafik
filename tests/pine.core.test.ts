import { describe, expect, it } from "vitest";
import { check, run } from "../src/pine";
import type { PineOutput, RunResult } from "../src/pine/types";
import { barsFromCloses } from "./helpers";

function ok(r: RunResult): PineOutput {
  if (!r.ok) throw new Error(JSON.stringify("error" in r ? r.error : r.needData));
  return r.output;
}

/** İlk plot'un değerleri (NaN → null). */
function plot0(code: string, closes: number[], idx = 0): (number | null)[] {
  const out = ok(run(code, barsFromCloses(closes)));
  return [...out.plots[idx]!.values].map((v) => (Number.isNaN(v) ? null : +v.toFixed(10)));
}

describe("sözdizimi", () => {
  it("girinti blokları, satır devamı, yorumlar", () => {
    const code = `//@version=5
indicator("t", overlay=true)
a = 1 +
   2 // yorum
b = math.max(a,
     10)
if a > 2
    b := b + 1
plot(b)`;
    expect(plot0(code, [1, 2, 3])).toEqual([11, 11, 11]);
  });

  it("hata konumu satır:sütun ile", () => {
    const r = check(`indicator("x")\nplot(close +)`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.line).toBe(2);
    const r2 = check(`indicator("x")\n  plot(close)`);
    expect(r2.ok).toBe(false);
  });

  it("library ve import açık hata verir", () => {
    const r = run(`library("l")\nplot(close)`, barsFromCloses([1, 2]));
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) expect(r.error.message).toContain("library");
    expect(check(`import foo/bar/1 as b`).ok).toBe(false);
  });
});

describe("yürütme modeli", () => {
  it("geçmiş erişimi ve na", () => {
    expect(plot0(`indicator("t")\nplot(close[1])`, [1, 2, 3])).toEqual([null, 1, 2]);
    expect(plot0(`indicator("t")\nplot(nz(close[2], -1))`, [1, 2, 3])).toEqual([-1, -1, 1]);
  });

  it("var bir kez başlatılır, := güncellenir", () => {
    const code = `indicator("t")\nvar c = 0\nc := c + 1\nplot(c)`;
    expect(plot0(code, [5, 5, 5, 5])).toEqual([1, 2, 3, 4]);
  });

  it("özyinelemeli seri (x = 0.0; x := f(x[1]))", () => {
    const code = `indicator("t")\nx = 0.0\nx := nz(x[1]) + close\nplot(x)`;
    expect(plot0(code, [1, 2, 3])).toEqual([1, 3, 6]);
  });

  it("if ifadesi, switch, ternary", () => {
    const code = `indicator("t")
v = if close > 2
    10
else if close > 1
    5
else
    1
s = switch
    close == 1 => 100
    => 200
t = close >= 3 ? v : s
plot(t)`;
    expect(plot0(code, [1, 2, 3])).toEqual([100, 200, 10]);
  });

  it("for döngüsü, break/continue, while", () => {
    const code = `indicator("t")
sum = 0.0
for i = 0 to 10
    if i == 3
        continue
    if i > 5
        break
    sum += i
k = 0
while k < 4
    k += 1
plot(sum + k)`;
    expect(plot0(code, [1])).toEqual([0 + 1 + 2 + 4 + 5 + 4]);
  });

  it("fonksiyonlar: çağrı yeri başına ayrı durum", () => {
    const code = `indicator("t")
f(src) => ta.sma(src, 2)
a = f(close)
b = f(close * 10)
plot(a)
plot(b)`;
    const out = ok(run(code, barsFromCloses([1, 3, 5])));
    expect([...out.plots[0]!.values].slice(1)).toEqual([2, 4]);
    expect([...out.plots[1]!.values].slice(1)).toEqual([20, 40]);
  });

  it("fonksiyon yerel değişken geçmişi ve demet dönüşü", () => {
    const code = `indicator("t")
g(x) =>
    y = x * 2
    [y, nz(y[1])]
[a, b] = g(close)
plot(a)
plot(b)`;
    const out = ok(run(code, barsFromCloses([1, 2, 3])));
    expect([...out.plots[0]!.values]).toEqual([2, 4, 6]);
    expect([...out.plots[1]!.values]).toEqual([0, 2, 4]);
  });

  it("genel değişkeni fonksiyon okuyabilir, ama değiştiremez", () => {
    const code = `indicator("t")\nk = 3\nf() => close * k\nplot(f())`;
    expect(plot0(code, [1, 2])).toEqual([3, 6]);
    const bad = run(`indicator("t")\nk = 3\nf() =>\n    k := 1\n    k\nplot(f())`, barsFromCloses([1]));
    expect(bad.ok).toBe(false);
  });

  it("diziler ve yöntem sözdizimi", () => {
    const code = `indicator("t")
var a = array.new_float()
a.push(close)
if a.size() > 3
    a.shift()
plot(a.sum())
plot(array.get(a, 0))`;
    const out = ok(run(code, barsFromCloses([1, 2, 3, 4, 5])));
    expect([...out.plots[0]!.values]).toEqual([1, 3, 6, 9, 12]);
    expect([...out.plots[1]!.values]).toEqual([1, 1, 1, 2, 3]);
  });

  it("sıfıra bölme na, v4 iff ve öneksiz adlar", () => {
    const code = `//@version=4
study("t")
x = iff(close > 1, 1 / 0, 7)
plot(nz(x, -1))
plot(sma(close, 2))`;
    const out = ok(run(code, barsFromCloses([1, 3])));
    expect([...out.plots[0]!.values]).toEqual([7, -1]);
    expect(out.plots[1]!.values[1]).toBe(2);
    expect(out.meta.title).toBe("t");
  });

  it("sonsuz döngü süre sınırına takılır", () => {
    const r = run(`indicator("t")\nk = 0\nwhile true\n    k += 1\nplot(k)`, barsFromCloses([1]), { timeLimitMs: 200 });
    expect(r.ok).toBe(false);
    if (!r.ok && "error" in r) expect(r.error.kind).toBe("limit");
  });
});

describe("girdiler ve çıktılar", () => {
  it("girdiler tanımlanır ve değerleri uygulanır", () => {
    const code = `indicator("RSI", overlay=false)
len = input.int(14, "Uzunluk", minval=2, maxval=50)
src = input.source(close, "Kaynak")
show = input.bool(true, "Göster")
plot(show ? ta.sma(src, len) : na, "SMA")`;
    const bars = barsFromCloses([1, 2, 3, 4, 5, 6]);
    const a = ok(run(code, bars));
    expect(a.inputs.map((i) => [i.key, i.type, i.defval])).toEqual([
      ["Uzunluk", "int", 14],
      ["Kaynak", "source", "close"],
      ["Göster", "bool", true],
    ]);
    expect(Number.isNaN(a.plots[0]!.values[5]!)).toBe(true);
    const b = ok(run(code, bars, { inputs: { Uzunluk: 2, Kaynak: "open" } }));
    expect(b.plots[0]!.values[5]).toBe((4 + 5) / 2);
    const c = ok(run(code, bars, { inputs: { Uzunluk: 999 } })); // maxval'a kırpılır
    expect(Number.isNaN(c.plots[0]!.values[5]!)).toBe(true);
  });

  it("v4 input(type=…) ve kaynak çıkarımı", () => {
    const code = `//@version=4
study("x")
a = input(2, title="A")
s = input(close, title="Kaynak")
f = input(1.5, "F", type=input.float)
plot(a * f + s)`;
    const out = ok(run(code, barsFromCloses([10])));
    expect(out.inputs.map((i) => i.type)).toEqual(["int", "source", "float"]);
    expect(out.plots[0]!.values[0]).toBe(13);
  });

  it("plotshape, barcolor, bgcolor, hline, alertcondition", () => {
    const code = `indicator("x", overlay=true)
up = close > open
plotshape(up, "Al", shape.labelup, location.belowbar, color.green, text="AL")
barcolor(up ? color.lime : na)
bgcolor(up ? color.new(color.green, 90) : na)
hline(50, "Orta", color.gray)
alertcondition(up, "Yükseliş", "fiyat yükseldi")`;
    const out = ok(run(code, barsFromCloses([1, 2, 1, 3])));
    expect(out.meta.overlay).toBe(true);
    expect(out.shapes[0]!.events.map((e) => e.bar)).toEqual([1, 3]);
    expect(out.shapes[0]!.events[0]).toMatchObject({ location: "belowbar", shape: "labelup", text: "AL" });
    expect(out.barcolors).toEqual([null, "#00E676FF", null, "#00E676FF"]);
    expect(out.bgcolors![1]).toBe("#4CAF5019");
    expect(out.hlines[0]).toMatchObject({ price: 50, title: "Orta", style: "dashed" });
    expect(out.alerts[0]).toMatchObject({ title: "Yükseliş", bars: [1, 3] });
  });

  it("çizim nesneleri uyarıyla yok sayılır", () => {
    const code = `indicator("x", overlay=true)
var table t = table.new(position.top_right, 2, 2)
if barstate.islast
    table.cell(t, 0, 0, "a")
    label.new(bar_index, high, "x", style=label.style_label_down)
plot(close)`;
    const out = ok(run(code, barsFromCloses([1, 2])));
    expect(out.warnings.some((w) => w.includes("Çizim"))).toBe(true);
    expect(out.plots).toHaveLength(1);
  });
});
