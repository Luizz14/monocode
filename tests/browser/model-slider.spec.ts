import { expect, test, type Locator, type Page } from "@playwright/test";

async function openSlider(page: Page) {
  await page.goto("/tests/browser/model-slider.html");
  await page.locator("[data-model-picker-trigger]").click();
  const track = page.getByRole("slider", { name: "Model preset" });
  await expect(track).toBeFocused();
  // The popover scales in; measure once the rail is at full size.
  await expect.poll(async () => (await track.boundingBox())?.width).toBe(342);
  return track;
}

/** Page x of a step's dot on the default six-stop rail. */
async function dotX(track: Locator, index: number) {
  const box = (await track.boundingBox())!;
  return { x: box.x + 18 + (index * 306) / 5, y: box.y + box.height / 2 };
}

test("drags across presets and applies the one it is released on", async ({
  page,
}, testInfo) => {
  const track = await openSlider(page);
  const choice = page.locator("[data-choice]");
  await expect(track).toHaveAttribute("aria-valuetext", "Opus 5.5 High");

  const from = await dotX(track, 2);
  const to = await dotX(track, 4);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x + 6, to.y, { steps: 8 });
  await expect(track).toHaveAttribute("aria-valuetext", "Opus 5.5 Ultracode");
  await expect(page.locator("[data-model-slider]")).toHaveAttribute(
    "data-effort-tone",
    "ultracode",
  );
  // Nothing is applied until the knob is let go.
  await expect(choice).toHaveText("claude:opus-5-5 high");
  await page.screenshot({ path: testInfo.outputPath("dragging.png") });

  await page.mouse.up();
  await expect(choice).toHaveText("claude:opus-5-5 ultracode");
  await expect(track).toHaveAttribute("aria-valuenow", "4");
  // The knob settles centered on the dot it landed on.
  await expect
    .poll(async () => {
      const knob = (await page.locator(".model-slider-knob").boundingBox())!;
      return Math.round(knob.x + knob.width / 2 - to.x);
    })
    .toBe(0);
});

test("steps from the keyboard, switching the model when a preset needs it", async ({
  page,
}) => {
  const track = await openSlider(page);
  const choice = page.locator("[data-choice]");

  await page.keyboard.press("ArrowRight");
  await expect(choice).toHaveText("claude:opus-5-5 max");
  await page.keyboard.press("Home");
  await expect(choice).toHaveText("claude:sonnet-5 medium");
  await expect(track).toHaveAttribute("aria-valuetext", "Sonnet 5 Medium");
  await expect(page.locator("[data-model-picker-trigger]")).toHaveText(
    /Sonnet 5\s*Medium/,
  );

  await page.keyboard.press("Escape");
  await expect(track).toHaveCount(0);
});

test("lights the rail for Max, Ultracode, and Ultrathink", async ({ page }) => {
  await page.goto("/tests/browser/model-slider.html?view=states");
  const tones = page.locator("[data-model-slider]");
  await expect(tones).toHaveCount(4);
  expect(
    await tones.evaluateAll((panels) =>
      panels.map((panel) => panel.getAttribute("data-effort-tone")),
    ),
  ).toEqual([null, "max", "ultracode", "ultrathink"]);
  await expect(page.locator(".model-slider-tiles")).toHaveCount(3);
});
