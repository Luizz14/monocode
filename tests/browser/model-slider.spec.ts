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
  // Pause at the end so the knob arrives before the way back.
  await page.waitForTimeout(250);
  centers.push((await sample()).center - box.x);
  for (let x = 330; x >= 40; x -= 9) {
    await page.mouse.move(box.x + x, y);
    const { gap, center } = await sample();
    gaps.push(gap);
    centers.push(center - box.x);
  }
  await page.waitForTimeout(250);
  centers.push((await sample()).center - box.x);
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

test("shows the panel's inset line over composited glass", async ({
  page,
}, testInfo) => {
  // The same path as the app: the docked composer's model chip opens the
  // panel. A real backdrop filter gets its own compositing layer in WebKit,
  // which this headless build never draws, so force one, with a dense tint
  // that would hide any line painted beneath it.
  await page.goto("/tests/browser/model-slider.html?view=active");
  await page.addStyleTag({
    content:
      ".popover-backdrop{will-change:transform;transform:translateZ(0);background:rgb(40 40 40 / 0.9)!important}",
  });
  await page.locator("[data-model-picker-trigger]").click();
  const panel = page.locator("[data-model-slider]");
  await expect(panel).toBeVisible();
  await page.waitForTimeout(600);
  const frame = await panel.evaluate((el) => {
    let node: HTMLElement = el as HTMLElement;
    while (node.parentElement && node.parentElement !== document.body) {
      node = node.parentElement;
    }
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width };
  });
  const shot = await page.screenshot({
    clip: { x: frame.x + frame.width / 2 - 2, y: frame.y, width: 4, height: 6 },
  });
  // Red channel down the middle of the panel's top edge: row 1 is the line,
  // 1-2px inside the edge; rows 0 and 3 are the glass around it.
  const column = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return Array.from(
      { length: image.height },
      (_, row) => context.getImageData(2, row, 1, 1).data[0],
    );
  }, shot.toString("base64"));
  const note = `top edge, red channel by row: ${column.join(", ")}`;
  testInfo.annotations.push({ type: "inset line", description: note });
  console.log(note);
  expect(column[1] - column[0]).toBeGreaterThan(10);
  expect(column[1] - column[3]).toBeGreaterThan(10);
});

test("marks keyboard focus with a glow, not a ring", async ({ page }) => {
  const track = await openSlider(page);
  const knob = page.locator(".model-slider-knob");
  const looks = () =>
    page.evaluate(() => {
      const track = document.querySelector<HTMLElement>('[role="slider"]')!;
      const knob = document.querySelector<HTMLElement>(".model-slider-knob")!;
      return {
        track: getComputedStyle(track).outlineColor,
        knob: getComputedStyle(knob).outlineColor,
        glow: getComputedStyle(knob).boxShadow,
      };
    });
  const resting = await looks();
  expect(resting.glow).toBe("none");

  await page.keyboard.press("ArrowLeft");
  await expect(track).toBeFocused();
  await expect.poll(async () => (await looks()).glow).not.toBe("none");
  const focused = await looks();
  // The rail and the knob keep their resting lines.
  expect(focused.track).toBe(resting.track);
  expect(focused.knob).toBe(resting.knob);
  await expect(knob).toBeVisible();

  // A pointer press drops the glow again.
  const box = (await track.boundingBox())!;
  await page.mouse.click(box.x + 48, box.y + 13);
  await expect.poll(async () => (await looks()).glow).toBe("none");
});

test("sets the composer chip in the bundled faces", async ({
  page,
}, testInfo) => {
  await page.goto("/tests/browser/model-slider.html?view=active");
  const chip = page.locator("[data-model-picker-trigger]");
  await expect(chip).toBeVisible();
  // Nothing opened: the chip alone has to bring the faces in.
  const result = await page.evaluate(async () => {
    await document.fonts.ready;
    const chip = document.querySelector("[data-model-picker-trigger]")!;
    const name = chip.querySelector<HTMLElement>(".model-slider-model")!;
    const effort = chip.querySelector<HTMLElement>(".model-slider-effort")!;
    const probe = (text: string, font: string) => {
      const span = document.createElement("span");
      span.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${font}`;
      span.textContent = text;
      document.body.append(span);
      const width = span.getBoundingClientRect().width;
      span.remove();
      return width;
    };
    const nameText = name.textContent!;
    const effortText = effort.textContent!;
    return {
      nameFont: getComputedStyle(name).fontFamily,
      effortFont: getComputedStyle(effort).fontFamily,
      nameWeight: getComputedStyle(name).fontWeight,
      effortStyle: getComputedStyle(effort).fontStyle,
      monoLoaded: document.fonts.check(
        '500 12px "MonoCode Slider Mono"',
        nameText,
      ),
      serifLoaded: document.fonts.check(
        'italic 400 12px "MonoCode Slider Serif"',
        effortText,
      ),
      name: name.getBoundingClientRect().width,
      nameBundled: probe(nameText, '500 12px "MonoCode Slider Mono"'),
      nameSystem: probe(nameText, "500 12px ui-monospace"),
      effort: effort.getBoundingClientRect().width,
      effortBundled: probe(
        effortText,
        'italic 400 12px "MonoCode Slider Serif"',
      ),
      effortSystem: probe(effortText, "italic 400 12px Georgia"),
    };
  });
  const note = JSON.stringify(result);
  testInfo.annotations.push({ type: "chip fonts", description: note });
  console.log(`chip fonts: ${note}`);
  expect(result.nameFont).toMatch(/^"?MonoCode Slider Mono/);
  expect(result.effortFont).toMatch(/^"?MonoCode Slider Serif/);
  expect(result.nameWeight).toBe("500");
  expect(result.effortStyle).toBe("italic");
  expect(result.monoLoaded).toBe(true);
  expect(result.serifLoaded).toBe(true);
  expect(Math.abs(result.name - result.nameBundled)).toBeLessThan(0.5);
  expect(Math.abs(result.nameBundled - result.nameSystem)).toBeGreaterThan(1);
  expect(Math.abs(result.effort - result.effortBundled)).toBeLessThan(0.5);
  expect(Math.abs(result.effortBundled - result.effortSystem)).toBeGreaterThan(
    1,
  );
});

for (const view of ["new", "active"] as const) {
  test(`puts the paperclip right before Send in the ${view} composer`, async ({
    page,
  }, testInfo) => {
    await page.goto(
      `/tests/browser/model-slider.html${view === "active" ? "?view=active" : ""}`,
    );
    const box = page.locator("[data-composer-box]");
    const attach = box.getByRole("button", {
      name: "Add files or choose a mode",
    });
    const send = box.locator(
      view === "active" ? 'button[aria-label="Stop"]' : ".composer-send",
    );
    const access = box.locator("[data-access-picker-trigger]");
    const [a, s, c, b] = await Promise.all([
      attach.boundingBox(),
      send.boundingBox(),
      access.boundingBox(),
      box.boundingBox(),
    ]);
    const note = `attach ${a!.x - b!.x},${a!.y - b!.y} ${a!.width}x${a!.height}; send ${s!.x - b!.x}; gap ${s!.x - (a!.x + a!.width)}`;
    testInfo.annotations.push({ type: "attach", description: note });
    console.log(`${view}: ${note}`);
    // Same row as Send, 4px to its left, and right of the chips.
    expect(a!.y).toBe(s!.y);
    expect(a!.width).toBe(26);
    expect(s!.x - (a!.x + a!.width)).toBe(4);
    expect(a!.x).toBeGreaterThan(c!.x + c!.width);

    const background = () =>
      attach.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await background()).toBe("rgba(0, 0, 0, 0)");
    await attach.hover();
    await expect.poll(background).not.toBe("rgba(0, 0, 0, 0)");

    await attach.click();
    const menu = page.locator("[data-composer-plus]");
    await expect(menu).toContainText("Upload file");
    const m = (await menu.boundingBox())!;
    // Opens above the button, inward from the composer's right side.
    expect(m.y + m.height).toBeLessThanOrEqual(a!.y);
    expect(m.x + m.width).toBeLessThanOrEqual(b!.x + b!.width);
    expect(Math.abs(m.x + m.width - (a!.x + a!.width))).toBeLessThan(4);
  });
}
