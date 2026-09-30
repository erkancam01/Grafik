import { describe, expect, it } from "vitest";
import { mergeBarColors, plotPoints, priceAxisFormat, priceDigits, seriesKind, shapeMarkers } from "../src/chart/render";
import type { PlotOut, ShapeOut } from "../src/pine/types";

const plot = (over: Partial<PlotOut>): PlotOut => ({
  id: "p1",
  title: "x",
  style: "line",
  linewidth: 1,
  values: Float64Array.from([1, Number.NaN, 3]),
  colors: ["#FF0000FF", "#FF0000FF", null],
  offset: 0,
  histbase: 0,
  display: true,
  trackprice: false,
  ...over,
});

describe("çizim dönüşümleri", () => {
  it("line boşlukları bağlar, linebr koparır; na renk = görünmez nokta", () => {
    const t = [100, 200, 300];
    expect(plotPoints(plot({}), t, 100)).toEqual([{ time: 100, value: 1, color: "rgba(255, 0, 0, 1)" }]);
    const br = plotPoints(plot({ style: "linebr", colors: ["#FF0000FF", "#FF0000FF", "#00FF0080"] }), t, 100);
    expect(br).toEqual([
      { time: 100, value: 1, color: "rgba(255, 0, 0, 1)" },
      { time: 200 },
      { time: 300, value: 3, color: "rgba(0, 255, 0, 0.502)" },
    ]);
  });

  it("offset ileri kaydırır (gelecek zaman üretilir)", () => {
    const pts = plotPoints(plot({ offset: 2, colors: ["#FFFFFFFF", "#FFFFFFFF", "#FFFFFFFF"] }), [100, 200, 300], 100);
    expect(pts.map((p) => p.time)).toEqual([300, 500]);
    expect(seriesKind("columns")).toBe("histogram");
  });

  it("şekiller işaretçiye, mum renkleri birleşir, basamaklar", () => {
    const s: ShapeOut = {
      id: "s",
      title: "Al",
      kind: "shape",
      offset: 0,
      events: [{ bar: 1, price: null, location: "belowbar", shape: "labelup", color: "#00FF00FF", text: "Al", textcolor: null, size: "tiny" }],
    };
    expect(shapeMarkers(s, [10, 20])).toEqual([
      { time: 20, position: "belowBar", shape: "arrowUp", color: "rgba(0, 255, 0, 1)", size: 0.6, text: "Al" },
    ]);
    expect(mergeBarColors([["#FF0000FF", null], [null, "#0000FFFF"]], 2)).toEqual(["rgba(255, 0, 0, 1)", "rgba(0, 0, 255, 1)"]);
    expect([priceDigits(112000), priceDigits(210.3), priceDigits(22.4), priceDigits(2.87), priceDigits(0.241)]).toEqual([1, 2, 3, 4, 5]);
  });

  it("fiyat ekseninde eksi etiket yok", () => {
    const f = priceAxisFormat(1);
    expect([f.formatter(-10000), f.formatter(0), f.formatter(83821.54)]).toEqual(["", "0.0", "83821.5"]);
    expect(f.minMove).toBeCloseTo(0.1, 12);
  });
});
