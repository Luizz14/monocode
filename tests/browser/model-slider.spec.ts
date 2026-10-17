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
      return Math.abs(knob.x + knob.width / 2 - to.x);
    })
    .toBeLessThan(1);
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

test("gives each effort level its icon and color, and lights the top three", async ({
  page,
}) => {
  await page.goto("/tests/browser/model-slider.html?view=states");
  const panels = page.locator("[data-model-slider]");
  await expect(panels).toHaveCount(7);
  const looks = await panels.evaluateAll((all) =>
    all.map((panel) => ({
      level: panel.getAttribute("data-effort-level"),
      tone: panel.getAttribute("data-effort-tone"),
      icon: panel
        .querySelector("svg[data-effort-icon]")
        ?.getAttribute("data-effort-icon"),
      color: getComputedStyle(panel.querySelector(".model-slider-globe")!)
        .color,
      text: panel.querySelector(".model-slider-effort")?.textContent,
    })),
  );
  expect(looks.map((look) => look.level)).toEqual([
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultracode",
    "ultrathink",
  ]);
  expect(looks.map((look) => look.icon)).toEqual(
    looks.map((look) => look.level),
  );
  expect(looks.map((look) => look.tone)).toEqual([
    null,
    null,
    null,
    null,
    "max",
    "ultracode",
    "ultrathink",
  ]);
  // Every level has its own color, and its name stays in words.
  expect(new Set(looks.map((look) => look.color)).size).toBe(7);
  expect(looks.map((look) => look.text)).toEqual([
    "Low",
    "Medium",
    "High",
    "Extra High",
    "Max",
    "Ultracode",
    "Ultrathink",
  ]);
  await expect(page.locator(".model-slider-tiles")).toHaveCount(3);
});

test("sets the slider in the bundled faces", async ({ page }) => {
  await page.goto("/tests/browser/model-slider.html?view=states");
  await expect(page.locator("[data-model-slider]").first()).toBeVisible();
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) =>
        face.family.replace(/"/g, "").startsWith("MonoCode Slider"),
      )
      .filter((face) => face.status === "loaded")
      .map(
        (face) =>
          `${face.family.replace(/"/g, "")} ${face.style} ${face.weight}`,
      );
  });
  expect(loaded).toEqual(
    expect.arrayContaining([
      "MonoCode Slider Mono normal 500",
      "MonoCode Slider Serif italic 400",
    ]),
  );
});
