import { expect, test } from "@playwright/test";

type FixtureWindow = Window & {
  mountCodeTranscript: () => void;
  finishFrameSamples: () => number[];
};

test("the first code block colors without stalling the main thread", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.goto("/tests/browser/code-highlight.html");
  await page.waitForFunction(
    () => !!(window as unknown as FixtureWindow).mountCodeTranscript,
  );
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => {
    const gaps: number[] = [];
    let last = performance.now();
    let frame = 0;
    const sample = (now: number) => {
      gaps.push(now - last);
      last = now;
      frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    Object.assign(window, {
      finishFrameSamples: () => {
        cancelAnimationFrame(frame);
        return gaps;
      },
    });
    (window as unknown as FixtureWindow).mountCodeTranscript();
  });
  const code = page.locator('[data-streamdown="code-block-body"] code');
  await expect(code).toContainText("reduce");
  // Tokens arrive from the highlight worker; plain text alone means it failed.
  await expect(code.locator("span span").first()).toBeVisible({
    timeout: 30_000,
  });
  const colored = await code
    .locator("span span")
    .evaluateAll((spans) =>
      new Set(spans.map((span) => getComputedStyle(span).color)).size,
    );
  expect(colored).toBeGreaterThan(1);
  await page.waitForTimeout(200);
  const gaps = await page.evaluate(() =>
    (window as unknown as FixtureWindow).finishFrameSamples(),
  );
  // Grammar compilation blocked frames for about a second when it ran here.
  expect(Math.max(...gaps)).toBeLessThan(250);
});
