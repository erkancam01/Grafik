import { describe, expect, it } from "vitest";
import { daysAgo, fromDateInput, startOfYear, toDateInput } from "../src/ui/dates";

describe("tarih girişleri (yerel saat)", () => {
  it("gün başı / gün sonu ve geri dönüşüm", () => {
    const a = fromDateInput("2025-03-09");
    const b = fromDateInput("2025-03-09", true);
    expect(b - a).toBe(86_400_000 - 1);
    expect(toDateInput(a)).toBe("2025-03-09");
    expect(toDateInput(b)).toBe("2025-03-09");
    expect(Number.isNaN(fromDateInput(""))).toBe(true);
    expect(toDateInput(Number.NaN)).toBe("");
  });

  it("hazır dönemler", () => {
    const now = new Date(2026, 8, 30, 15, 0).getTime();
    expect(toDateInput(daysAgo(365, now))).toBe("2025-09-30");
    expect(toDateInput(startOfYear(now))).toBe("2026-01-01");
  });
});
