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
  return { x: box.x + 48 + (index * 276) / 5, y: box.y + box.height / 2 };
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

test("gives each model family its icon and color, and lights the top three", async ({
  page,
}) => {
  await page.goto("/tests/browser/model-slider.html?view=states");
  const panels = page.locator("[data-model-slider]");
  await expect(panels).toHaveCount(9);
  const looks = await panels.evaluateAll((all) =>
    all.map((panel) => ({
      family: panel.getAttribute("data-model-family"),
      legacy: panel.hasAttribute("data-model-legacy"),
      tone: panel.getAttribute("data-effort-tone"),
      icon: panel
        .querySelector("svg[data-model-icon]")
        ?.getAttribute("data-model-icon"),
      color: getComputedStyle(panel.querySelector(".model-slider-globe")!)
        .color,
      model: panel.querySelector(".model-slider-model")?.textContent,
    })),
  );
  expect(
    looks.map((look) => `${look.family}${look.legacy ? " old" : ""}`),
  ).toEqual([
    "haiku old",
    "sonnet",
    "sonnet old",
    "opus",
    "opus old",
    "fable",
    "opus",
    "opus",
    "opus",
  ]);
  expect(looks.map((look) => look.icon)).toEqual(
    looks.map((look) => look.family),
  );
  // The model's name stays in words beside its icon.
  expect(looks.map((look) => look.model)).toEqual([
    "Haiku 4.5",
    "Sonnet 5",
    "Sonnet 4.6",
    "Opus 5.5",
    "Opus 4.8",
    "Fable 5",
    "Opus 5.5",
    "Opus 5.5",
    "Opus 5.5",
  ]);
  // Four families, each older generation a shade of its own, and the
  // effects keep the model's color on the icon.
  const color = (index: number) => looks[index].color;
  expect(new Set([0, 1, 3, 5].map(color)).size).toBe(4);
  expect(color(2)).not.toBe(color(1));
  expect(color(4)).not.toBe(color(3));
  expect([6, 7, 8].map(color)).toEqual([color(3), color(3), color(3)]);
  expect(looks.map((look) => look.tone)).toEqual([
    null,
    null,
    null,
    null,
    null,
    null,
    "max",
    "ultracode",
    "ultrathink",
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

test("keeps the fill's end under the knob's center through a drag", async ({
  page,
}, testInfo) => {
  const track = await openSlider(page);
  const box = (await track.boundingBox())!;
  const y = box.y + box.height / 2;
  // Knob center from layout, fill end from the fill's box minus its clip.
  const sample = () =>
    page.evaluate(() => {
      const knob = document
        .querySelector(".model-slider-knob")!
        .getBoundingClientRect();
      const fill = document.querySelector<HTMLElement>(".model-slider-fill")!;
      const rect = fill.getBoundingClientRect();
      const inset = /inset\(0(?:px)? (-?[\d.]+)px/.exec(
        getComputedStyle(fill).clipPath,
      );
      const center = knob.left + knob.width / 2;
      return {
        center,
        gap: Math.abs(center - (rect.right - Number(inset![1]))),
      };
    });

  const gaps: number[] = [];
  const centers: number[] = [];
  await page.mouse.move(box.x + 158.4, y);
  await page.mouse.down();
  for (let x = 158.4; x <= 330; x += 6) {
    await page.mouse.move(box.x + x, y);
    const { gap, center } = await sample();
    gaps.push(gap);
    centers.push(center - box.x);
  }
  for (let x = 330; x >= 40; x -= 9) {
    await page.mouse.move(box.x + x, y);
    const { gap, center } = await sample();
    gaps.push(gap);
    centers.push(center - box.x);
  }
  await page.mouse.move(box.x + 120, y);
  await page.mouse.up();
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(16);
    gaps.push((await sample()).gap);
  }

  const max = Math.max(...gaps);
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const note = `${gaps.length} samples, max ${max.toFixed(4)}px, mean ${mean.toFixed(4)}px`;
  testInfo.annotations.push({ type: "alignment", description: note });
  console.log(`knob/fill alignment: ${note}`);
  expect(max).toBeLessThan(1);
  // The knob really moved through the rail, not just between two dots.
  expect(Math.max(...centers) - Math.min(...centers)).toBeGreaterThan(200);
});
