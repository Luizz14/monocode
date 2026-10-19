// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SafeHtml, sanitizeProviderHtml } from "./SafeHtml";

const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

describe("sanitizeProviderHtml", () => {
  it("drops scripts, styles, frames and event handlers", () => {
    const html =
      '<div onclick="x()"><script>alert(1)</script><style>p{}</style>' +
      '<iframe srcdoc="x"></iframe><p style="color:red" class="c" id="p">' +
      "<b>Como</b> cliente</p><!-- note --><font color=\"red\">kept text</font>" +
      "<img src=\"x\" onerror=\"alert(1)\"></div>";
    expect(sanitizeProviderHtml(html)).toBe(
      '<div><p><b>Como</b> cliente</p>kept text<span data-attachment="">Image: image</span></div>',
    );
  });

  it("validates numeric attributes", () => {
    expect(
      sanitizeProviderHtml(
        '<table><tr><td colspan="2" rowspan="x">a</td></tr></table><ol start="-1"><li>x</li></ol>',
      ),
    ).toBe(
      '<table><tbody><tr><td colspan="2">a</td></tr></tbody></table><ol><li>x</li></ol>',
    );
  });

  it("keeps lists, tables and headings", () => {
    const html =
      "<h3>Critérios</h3><ul><li>Um</li><li>Dois<ol start=\"3\"><li>x</li></ol></li></ul>" +
      "<table><thead><tr><th colspan=\"2\">A</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";
    expect(sanitizeProviderHtml(html)).toBe(html);
  });

  it("keeps only http, https and mailto links and marks them safe", () => {
    const html =
      '<a href="https://docs.example.com/x">doc</a> ' +
      '<a href="javascript:alert(1)">bad</a> ' +
      '<a href="mailto:a@b.c" title="t">mail</a>';
    expect(sanitizeProviderHtml(html)).toBe(
      '<a href="https://docs.example.com/x" rel="noopener noreferrer" title="https://docs.example.com/x">doc</a> ' +
        "<a>bad</a> " +
        '<a href="mailto:a@b.c" title="t" rel="noopener noreferrer">mail</a>',
    );
  });

  it("turns images into attachment links", () => {
    const html =
      '<img src="https://dev.azure.com/o/p/_apis/wit/attachments/abc?fileName=tela.png" alt="">' +
      '<img src="data:image/png;base64,AAAA" alt="inline">';
    expect(sanitizeProviderHtml(html)).toBe(
      '<a href="https://dev.azure.com/o/p/_apis/wit/attachments/abc?fileName=tela.png" data-attachment="" rel="noopener noreferrer" title="https://dev.azure.com/o/p/_apis/wit/attachments/abc?fileName=tela.png">Image: tela.png</a>' +
        '<span data-attachment="">Image: inline</span>',
    );
  });

  it("keeps a claimed attachment image as an img without src", () => {
    const src =
      "https://dev.azure.com/o/p/_apis/wit/attachments/abc?fileName=tela.png";
    const html = `<p>Veja <img src="${src}" alt="" onerror="x()" style="width:9px"></p>`;
    const inlineImage = (value: string) =>
      value.includes("/_apis/wit/attachments/");
    expect(sanitizeProviderHtml(html, { inlineImage })).toBe(
      `<p>Veja <img data-src="${src}" alt="tela.png" data-attachment-image=""></p>`,
    );
    // Declined, or no option at all: the link it always was.
    const link = sanitizeProviderHtml(html);
    expect(link).toContain('<a href="');
    expect(link).not.toContain("<img");
    expect(sanitizeProviderHtml(html, { inlineImage: () => false })).toBe(link);
  });

  it("never inlines an image that is not http(s)", () => {
    const html =
      '<img src="data:image/png;base64,AAAA" alt="a"><img src="javascript:x" alt="b"><img alt="c">';
    expect(sanitizeProviderHtml(html, { inlineImage: () => true })).toBe(
      '<span data-attachment="">Image: a</span><span data-attachment="">Image: b</span><span data-attachment="">Image: c</span>',
    );
  });

  it("returns an empty string for blank input", () => {
    expect(sanitizeProviderHtml("  \n")).toBe("");
    expect(sanitizeProviderHtml("<script>x</script>")).toBe("");
  });
});

describe("SafeHtml", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    openUrl.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens links in the browser instead of navigating", async () => {
    await act(async () =>
      root.render(
        createElement(SafeHtml, {
          html: '<p>See <a href="https://docs.example.com/x">the doc</a></p>',
        }),
      ),
    );
    const anchor = container.querySelector("a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      anchor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://docs.example.com/x");
  });

  describe("inline images", () => {
    const src =
      "https://dev.azure.com/o/p/_apis/wit/attachments/abc?fileName=tela.png";
    const html = `<p>Antes <img src="${src}" alt="tela.png"> depois</p>`;
    const inlineImage = (value: string) =>
      value.includes("/_apis/wit/attachments/");

    async function settle() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    it("fills the image from resolveImage and reports clicks on it", async () => {
      const resolveImage = vi.fn(async () => "data:image/png;base64,AAAA");
      const onImageClick = vi.fn();
      await act(async () =>
        root.render(
          createElement(SafeHtml, {
            html,
            inlineImage,
            resolveImage,
            onImageClick,
          }),
        ),
      );
      await settle();
      expect(resolveImage).toHaveBeenCalledWith(src);
      const image = container.querySelector("img")!;
      expect(image.getAttribute("src")).toBe("data:image/png;base64,AAAA");
      expect(image.hasAttribute("data-src")).toBe(false);
      expect(image.getAttribute("alt")).toBe("tela.png");
      act(() => {
        image.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onImageClick).toHaveBeenCalledWith(
        "data:image/png;base64,AAAA",
        "tela.png",
      );
      expect(openUrl).not.toHaveBeenCalled();
    });

    it("falls back to the link when the image cannot be loaded", async () => {
      for (const resolveImage of [
        async () => null,
        async () => {
          throw new Error("Not an image");
        },
      ]) {
        await act(async () =>
          root.render(
            createElement(SafeHtml, { html, inlineImage, resolveImage }),
          ),
        );
        await settle();
        expect(container.querySelector("img")).toBeNull();
        const link = container.querySelector("a[data-attachment]")!;
        expect(link.getAttribute("href")).toBe(src);
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
        expect(link.textContent).toBe("Image: tela.png");
        await act(async () => root.render(createElement("div")));
      }
    });

    it("makes a link of the image when nothing can resolve it", async () => {
      await act(async () =>
        root.render(createElement(SafeHtml, { html, inlineImage })),
      );
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("a[data-attachment]")).not.toBeNull();
    });

    it("ignores an answer that arrives after the html changed or the view left", async () => {
      let answer!: (value: string | null) => void;
      const resolveImage = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            answer = resolve;
          }),
      );
      await act(async () =>
        root.render(createElement(SafeHtml, { html, inlineImage, resolveImage })),
      );
      const stale = container.querySelector("img")!;
      const lateAnswer = answer;
      await act(async () =>
        root.render(
          createElement(SafeHtml, {
            html: "<p>Outro texto</p>",
            inlineImage,
            resolveImage,
          }),
        ),
      );
      await act(async () => {
        lateAnswer("data:image/png;base64,AAAA");
      });
      await settle();
      expect(stale.hasAttribute("src")).toBe(false);
      expect(container.textContent).toBe("Outro texto");

      await act(async () =>
        root.render(createElement(SafeHtml, { html, inlineImage, resolveImage })),
      );
      const pending = container.querySelector("img")!;
      const unmountedAnswer = answer;
      await act(async () => root.render(createElement("div")));
      await act(async () => {
        unmountedAnswer("data:image/png;base64,BBBB");
      });
      await settle();
      expect(pending.hasAttribute("src")).toBe(false);
    });
  });

  it("shows the empty label when nothing survives", async () => {
    await act(async () =>
      root.render(
        createElement(SafeHtml, {
          html: "<script>x</script>",
          emptyLabel: "No description",
        }),
      ),
    );
    expect(container.textContent).toBe("No description");
    expect(container.querySelector(".safe-html")).toBeNull();
  });
});
