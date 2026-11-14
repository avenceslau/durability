import type { MessageInput, QueueSettings } from '../src/model';
import {
  element,
  errorMessage,
  numberField,
  setField,
  showNotice,
  textField,
} from './dom';

export const namePattern = '[a-z0-9][a-z0-9_\\-]{0,62}';

export const field = (
  label: string,
  control: Node,
  hint?: string
): HTMLLabelElement =>
  element(
    'label',
    { class: 'field' },
    element('span', {}, label),
    control,
    hint === undefined ? null : element('small', {}, hint)
  );

export const numberInput = (
  name: string,
  properties: Record<string, string | number | boolean | undefined> = {}
): HTMLInputElement =>
  element('input', {
    type: 'number',
    name,
    step: 1,
    ...properties,
  });

/** Runs a form's submit action with its button disabled and reports the outcome below it. */
export const handleSubmit = (
  form: HTMLFormElement,
  notice: HTMLElement,
  action: () => Promise<string>
): void => {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button?.setAttribute('disabled', '');
    action()
      .then((message) => showNotice(notice, message))
      .catch((error: unknown) =>
        showNotice(notice, errorMessage(error), 'error')
      )
      .finally(() => button?.removeAttribute('disabled'));
  });
};

export const limitModeChoices = (): HTMLFieldSetElement =>
  element(
    'fieldset',
    { class: 'choices' },
    element('legend', {}, 'Limit mode'),
    element(
      'label',
      {},
      element('input', {
        type: 'radio',
        name: 'limitMode',
        value: 'strict',
        checked: true,
      }),
      element('strong', {}, 'strict'),
      ' never exceeds the limit; moves permits between limiters only after work finishes.'
    ),
    element(
      'label',
      {},
      element('input', {
        type: 'radio',
        name: 'limitMode',
        value: 'fast',
      }),
      element('strong', {}, 'fast'),
      ' follows demand at once; may exceed the limit briefly.'
    )
  );

export const settingsForm = (
  save: (settings: QueueSettings) => Promise<void>
): {
  form: HTMLFormElement;
  update: (settings: QueueSettings) => void;
} => {
  const notice = element('p', { class: 'notice' });
  const form = element(
    'form',
    { class: 'stack' },
    element(
      'div',
      { class: 'inline' },
      field(
        'Min partitions',
        numberInput('min', { min: 1, max: 256, required: true })
      ),
      field(
        'Max partitions',
        numberInput('max', { min: 1, max: 256, required: true })
      ),
      field(
        'Target rate per partition',
        numberInput('targetRate', { min: 1, required: true }),
        'Accepted messages/s'
      ),
      field(
        'Max backlog',
        numberInput('maxBacklog', { min: 1, required: true }),
        'Per partition'
      ),
      field(
        'Max concurrency',
        numberInput('maxConcurrency', { min: 1, placeholder: 'none' }),
        'Empty means no limit'
      ),
      field(
        'Limiter target rate',
        numberInput('limiterTargetRate', { min: 1, required: true }),
        'Permit requests/s per limiter'
      )
    ),
    limitModeChoices(),
    element(
      'div',
      { class: 'actions' },
      element('button', { type: 'submit' }, 'Save settings')
    ),
    notice
  );

  // Live updates must not overwrite what the user is typing.
  let edited = false;
  form.addEventListener('input', () => {
    edited = true;
  });

  handleSubmit(form, notice, async () => {
    await save({
      partitions: {
        min: numberField(form, 'min') ?? 1,
        max: numberField(form, 'max') ?? 16,
        targetRate: numberField(form, 'targetRate') ?? 200,
      },
      maxConcurrency: numberField(form, 'maxConcurrency') ?? null,
      limitMode: textField(form, 'limitMode') === 'fast' ? 'fast' : 'strict',
      limiterTargetRate: numberField(form, 'limiterTargetRate') ?? 200,
      maxBacklog: numberField(form, 'maxBacklog') ?? 100_000,
    });
    edited = false;
    return 'Settings saved';
  });

  const update = (settings: QueueSettings): void => {
    if (edited) {
      return;
    }
    setField(form, 'min', settings.partitions.min);
    setField(form, 'max', settings.partitions.max);
    setField(form, 'targetRate', settings.partitions.targetRate);
    setField(form, 'maxBacklog', settings.maxBacklog);
    setField(form, 'maxConcurrency', settings.maxConcurrency);
    setField(form, 'limiterTargetRate', settings.limiterTargetRate);
    setField(form, 'limitMode', settings.limitMode);
  };

  return { form, update };
};

export const resizeForm = (
  resize: (count: number) => Promise<void>
): HTMLFormElement => {
  const notice = element('p', { class: 'notice' });
  const form = element(
    'form',
    { class: 'stack' },
    element(
      'div',
      { class: 'inline' },
      field(
        'Partitions',
        numberInput('count', { min: 1, max: 256, required: true })
      ),
      element(
        'div',
        { class: 'actions' },
        element('button', { type: 'submit' }, 'Resize now')
      )
    ),
    notice
  );
  handleSubmit(form, notice, async () => {
    const count = numberField(form, 'count') ?? 1;
    await resize(count);
    return `Resizing to ${count} partitions`;
  });
  return form;
};

export const sendMessagesForm = (
  send: (messages: MessageInput[]) => Promise<string>
): HTMLFormElement => {
  const notice = element('p', { class: 'notice' });
  const form = element(
    'form',
    { class: 'stack' },
    element(
      'div',
      { class: 'inline' },
      field(
        'Key',
        element('input', { name: 'key', required: true, value: 'test' })
      ),
      field(
        'Count',
        numberInput('count', { min: 1, max: 1_000, value: 10, required: true })
      )
    ),
    field(
      'Body (JSON)',
      element(
        'textarea',
        { name: 'body', rows: 3, spellcheck: false },
        '{ "hello": "world" }'
      )
    ),
    element(
      'label',
      { class: 'check' },
      element('input', { type: 'checkbox', name: 'spread' }),
      'Use a different key per message (key-0, key-1, ...) to spread across partitions'
    ),
    element(
      'div',
      { class: 'actions' },
      element('button', { type: 'submit' }, 'Send')
    ),
    notice
  );

  handleSubmit(form, notice, async () => {
    let body: unknown;
    try {
      body = JSON.parse(textField(form, 'body'));
    } catch {
      throw new Error('The body is not valid JSON');
    }
    const key = textField(form, 'key');
    const spread = new FormData(form).get('spread') !== null;
    const count = numberField(form, 'count') ?? 1;
    const messages = Array.from({ length: count }, (_, index) => ({
      key: spread ? `${key}-${index}` : key,
      body,
    }));
    return send(messages);
  });
  return form;
};
