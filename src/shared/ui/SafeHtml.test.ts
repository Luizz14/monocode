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
