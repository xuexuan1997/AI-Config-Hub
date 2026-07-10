import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inertAppShellOutside } from "./modal-background.js";

class FakeHtmlElement {
  readonly children: FakeHtmlElement[] = [];
  readonly classList = {
    contains: (name: string) => this.classes.has(name),
  };
  inert = false;
  parentElement: FakeHtmlElement | null = null;

  private readonly attributes = new Map<string, string>();
  private readonly classes = new Set<string>();

  constructor(...classes: string[]) {
    for (const name of classes) this.classes.add(name);
  }

  append(...children: FakeHtmlElement[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

describe("modal app-shell background", () => {
  beforeEach(() => {
    vi.stubGlobal("HTMLElement", FakeHtmlElement);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inerts both workspace content and app-shell navigation, then restores prior state", () => {
    const appShell = new FakeHtmlElement("app-shell");
    const sidebar = new FakeHtmlElement("sidebar");
    const main = new FakeHtmlElement();
    const workspace = new FakeHtmlElement("workspace");
    const preservedBackground = new FakeHtmlElement();
    const modal = new FakeHtmlElement();
    const trailingBackground = new FakeHtmlElement();
    appShell.append(sidebar, main);
    main.append(workspace);
    workspace.append(preservedBackground, modal, trailingBackground);
    preservedBackground.inert = true;
    preservedBackground.setAttribute("aria-hidden", "until-modal-closes");

    const restore = inertAppShellOutside(modal as unknown as HTMLElement);

    expect(sidebar.inert).toBe(true);
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");
    expect(preservedBackground.inert).toBe(true);
    expect(preservedBackground.getAttribute("aria-hidden")).toBe("true");
    expect(trailingBackground.inert).toBe(true);
    expect(trailingBackground.getAttribute("aria-hidden")).toBe("true");
    expect(main.inert).toBe(false);
    expect(workspace.inert).toBe(false);
    expect(modal.inert).toBe(false);

    restore();

    expect(sidebar.inert).toBe(false);
    expect(sidebar.getAttribute("aria-hidden")).toBeNull();
    expect(preservedBackground.inert).toBe(true);
    expect(preservedBackground.getAttribute("aria-hidden")).toBe("until-modal-closes");
    expect(trailingBackground.inert).toBe(false);
    expect(trailingBackground.getAttribute("aria-hidden")).toBeNull();
  });

  it("keeps shared background inert until every activation releases it", () => {
    const appShell = new FakeHtmlElement("app-shell");
    const sidebar = new FakeHtmlElement("sidebar");
    const main = new FakeHtmlElement();
    const modal = new FakeHtmlElement();
    appShell.append(sidebar, main);
    main.append(modal);

    const restoreFirst = inertAppShellOutside(modal as unknown as HTMLElement);
    const restoreSecond = inertAppShellOutside(modal as unknown as HTMLElement);

    restoreFirst();
    expect(sidebar.inert).toBe(true);
    expect(sidebar.getAttribute("aria-hidden")).toBe("true");

    restoreSecond();
    expect(sidebar.inert).toBe(false);
    expect(sidebar.getAttribute("aria-hidden")).toBeNull();
  });
});
