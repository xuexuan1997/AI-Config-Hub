interface ManagedBackgroundState {
  ariaHidden: string | null;
  inert: boolean;
  references: number;
}

const managedBackgroundStates = new WeakMap<HTMLElement, ManagedBackgroundState>();

/**
 * Makes every sibling branch between a modal and the app shell unavailable.
 * Inerting the branches instead of a modal ancestor keeps the dialog itself
 * interactive while covering navigation and workspace content alike.
 */
export function inertAppShellOutside(modalRoot: HTMLElement): () => void {
  const backgroundElements = appShellBackgroundElements(modalRoot);

  for (const element of backgroundElements) acquireBackgroundElement(element);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const element of backgroundElements) releaseBackgroundElement(element);
  };
}

function appShellBackgroundElements(modalRoot: HTMLElement): readonly HTMLElement[] {
  const appShell = ancestorAppShell(modalRoot);
  if (appShell === undefined) return [];

  const backgroundElements: HTMLElement[] = [];
  let activeBranch = modalRoot;

  while (activeBranch !== appShell) {
    const parent = activeBranch.parentElement;
    if (parent === null) return [];
    for (const sibling of Array.from(parent.children)) {
      if (sibling !== activeBranch && sibling instanceof HTMLElement) {
        backgroundElements.push(sibling);
      }
    }
    activeBranch = parent;
  }

  return backgroundElements;
}

function ancestorAppShell(element: HTMLElement): HTMLElement | undefined {
  let ancestor = element.parentElement;
  while (ancestor !== null) {
    if (ancestor.classList.contains("app-shell")) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return undefined;
}

function acquireBackgroundElement(element: HTMLElement): void {
  const existing = managedBackgroundStates.get(element);
  if (existing !== undefined) {
    existing.references += 1;
  } else {
    managedBackgroundStates.set(element, {
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.inert,
      references: 1,
    });
  }
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
}

function releaseBackgroundElement(element: HTMLElement): void {
  const state = managedBackgroundStates.get(element);
  if (state === undefined) return;
  state.references -= 1;
  if (state.references > 0) return;

  element.inert = state.inert;
  if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", state.ariaHidden);
  managedBackgroundStates.delete(element);
}
