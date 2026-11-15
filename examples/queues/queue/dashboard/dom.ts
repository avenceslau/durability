type Child = Node | string | null | undefined | false;

type Properties = Record<
  string,
  string | number | boolean | null | undefined | ((event: Event) => void)
>;

/**
 * Builds an element. Properties named `on<event>` become listeners; the rest
 * become attributes. Text children are inserted as text, never parsed as HTML.
 */
export const element = <Tag extends keyof HTMLElementTagNameMap>(
  tag: Tag,
  properties: Properties = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[Tag] => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(properties)) {
    if (typeof value === 'function') {
      node.addEventListener(name.slice(2), value);
      continue;
    }
    if (value === undefined || value === null || value === false) {
      continue;
    }
    node.setAttribute(name, value === true ? '' : String(value));
  }
  node.replaceChildren(
    ...children
      .flat()
      .filter(
        (child): child is Node | string =>
          child !== null && child !== undefined && child !== false
      )
  );
  return node;
};

export const svgElement = <Tag extends keyof SVGElementTagNameMap>(
  tag: Tag,
  attributes: Record<string, string | number> = {},
  ...children: (Node | string)[]
): SVGElementTagNameMap[Tag] => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  node.replaceChildren(...children);
  return node;
};

const compactFormat = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

export const compact = (value: number): string => compactFormat.format(value);

export const perSecond = (value: number): string => `${compact(value)}/s`;

export const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const dateTime = (at: number): string =>
  new Date(at).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Reads a number input; an empty field is `undefined`. */
export const numberField = (
  form: HTMLFormElement,
  name: string
): number | undefined => {
  const raw = new FormData(form).get(name);
  if (typeof raw !== 'string' || raw.trim() === '') {
    return undefined;
  }
  return Number(raw);
};

export const textField = (form: HTMLFormElement, name: string): string => {
  const raw = new FormData(form).get(name);
  return typeof raw === 'string' ? raw.trim() : '';
};

/** Sets a form control's current value, not just its default. */
export const setField = (
  form: HTMLFormElement,
  name: string,
  value: string | number | boolean | undefined | null
): void => {
  const control = form.elements.namedItem(name);
  if (control instanceof RadioNodeList) {
    control.value = String(value);
    return;
  }
  if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    control.checked = value === true;
    return;
  }
  if (
    control instanceof HTMLInputElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLTextAreaElement
  ) {
    control.value = value === undefined || value === null ? '' : String(value);
  }
};

/** A message line under a form; `kind` picks the colour. */
export const showNotice = (
  target: HTMLElement,
  text: string,
  kind: 'error' | 'ok' = 'ok'
): void => {
  target.textContent = text;
  target.className = `notice ${kind}`;
};
