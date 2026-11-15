import type {
  Destination,
  PartitionTarget,
  TargetSettings,
} from '../src/model';
import { element, numberField, setField, showNotice, textField } from './dom';
import { field, handleSubmit, namePattern, numberInput } from './forms';

const destinationTypes = [
  'rpc',
  'webhook',
  'service',
  'queue',
  'archive',
] as const;
type DestinationType = (typeof destinationTypes)[number];

export const targetForm = (
  save: (name: string, target: TargetSettings) => Promise<void>
): {
  form: HTMLFormElement;
  edit: (name: string, target: PartitionTarget) => void;
} => {
  const notice = element('p', { class: 'notice' });
  const nameInput = element('input', {
    name: 'name',
    required: true,
    pattern: namePattern,
    placeholder: 'billing-webhook',
  });
  const typeSelect = element(
    'select',
    { name: 'type' },
    destinationTypes.map((type) => element('option', { value: type }, type))
  );
  const destinationFields: Record<DestinationType, HTMLFieldSetElement> = {
    webhook: element(
      'fieldset',
      { class: 'inline' },
      field(
        'URL',
        element('input', {
          name: 'url',
          type: 'url',
          required: true,
          placeholder: 'https://example.com/hook',
        })
      ),
      field(
        'Signing secret',
        element('input', { name: 'secret', type: 'password' }),
        'Optional; signs bodies in X-Queue-Signature'
      )
    ),
    rpc: element(
      'fieldset',
      { class: 'inline' },
      field(
        'Service binding',
        element('input', { name: 'rpcBinding', required: true }),
        'To a class that extends QueueEntrypoint, declared in wrangler.jsonc'
      )
    ),
    service: element(
      'fieldset',
      { class: 'inline' },
      field(
        'Service binding',
        element('input', { name: 'binding', required: true }),
        'Declared in wrangler.jsonc; batches are POSTed to it'
      )
    ),
    queue: element(
      'fieldset',
      { class: 'inline' },
      field(
        'Queue',
        element('input', {
          name: 'queue',
          required: true,
          pattern: namePattern,
        })
      )
    ),
    archive: element(
      'fieldset',
      { class: 'inline' },
      element('p', { class: 'hint' }, 'Writes batches to the STORAGE bucket.')
    ),
  };

  // A disabled fieldset is skipped by validation and FormData, so only the chosen destination counts.
  const showDestination = (): void => {
    for (const type of destinationTypes) {
      const fieldset = destinationFields[type];
      fieldset.hidden = type !== typeSelect.value;
      fieldset.disabled = type !== typeSelect.value;
    }
  };
  typeSelect.addEventListener('change', showDestination);

  const cancel = element(
    'button',
    { type: 'button', class: 'secondary' },
    'Cancel edit'
  );
  const form = element(
    'form',
    { class: 'stack' },
    element(
      'div',
      { class: 'inline' },
      field('Name', nameInput),
      field('Destination', typeSelect)
    ),
    destinationTypes.map((type) => destinationFields[type]),
    element(
      'div',
      { class: 'inline' },
      field(
        'Max batch size',
        numberInput('maxBatchSize', { min: 1, max: 100, value: 10 })
      ),
      field(
        'Max retries',
        numberInput('maxRetries', { min: 0, max: 100, value: 3 }),
        'Then the message is dead-lettered'
      ),
      field(
        'Retry delay (s)',
        numberInput('retryDelaySeconds', { min: 0, max: 86_400, value: 0 })
      ),
      field(
        'Attempt timeout (ms)',
        numberInput('attemptTimeoutMs', {
          min: 100,
          max: 30_000,
          value: 10_000,
        })
      ),
      field(
        'Max per second',
        numberInput('maxPerSecond', { min: 1, placeholder: 'none' }),
        'Per partition'
      ),
      field(
        'Max concurrency',
        numberInput('maxConcurrency', { min: 1, placeholder: 'none' }),
        'Batches in flight, whole queue'
      ),
      field(
        'Start at',
        element(
          'select',
          { name: 'startAt' },
          element('option', { value: 'latest' }, 'latest'),
          element('option', { value: 'earliest' }, 'earliest')
        ),
        'Where a new target starts reading'
      )
    ),
    element(
      'label',
      { class: 'check' },
      element('input', { type: 'checkbox', name: 'paused' }),
      'Paused'
    ),
    element(
      'div',
      { class: 'actions' },
      element('button', { type: 'submit' }, 'Save target'),
      cancel
    ),
    notice
  );

  const reset = (): void => {
    form.reset();
    nameInput.readOnly = false;
    cancel.hidden = true;
    showDestination();
  };
  cancel.addEventListener('click', reset);
  reset();

  const readDestination = (): Destination => {
    const type = typeSelect.value as DestinationType;
    if (type === 'webhook') {
      const secret = textField(form, 'secret');
      return secret === ''
        ? { type, url: textField(form, 'url') }
        : { type, url: textField(form, 'url'), secret };
    }
    if (type === 'rpc') {
      return { type, binding: textField(form, 'rpcBinding') };
    }
    if (type === 'service') {
      return { type, binding: textField(form, 'binding') };
    }
    if (type === 'queue') {
      return { type, queue: textField(form, 'queue') };
    }
    return { type };
  };

  handleSubmit(form, notice, async () => {
    const name = textField(form, 'name');
    const target: TargetSettings = {
      destination: readDestination(),
      maxBatchSize: numberField(form, 'maxBatchSize') ?? 10,
      maxRetries: numberField(form, 'maxRetries') ?? 3,
      retryDelaySeconds: numberField(form, 'retryDelaySeconds') ?? 0,
      attemptTimeoutMs: numberField(form, 'attemptTimeoutMs') ?? 10_000,
      paused: new FormData(form).get('paused') !== null,
      startAt:
        textField(form, 'startAt') === 'earliest' ? 'earliest' : 'latest',
    };
    const maxPerSecond = numberField(form, 'maxPerSecond');
    if (maxPerSecond !== undefined) {
      target.maxPerSecond = maxPerSecond;
    }
    const maxConcurrency = numberField(form, 'maxConcurrency');
    if (maxConcurrency !== undefined) {
      target.maxConcurrency = maxConcurrency;
    }

    await save(name, target);
    reset();
    return `Saved target ${name}`;
  });

  const edit = (name: string, target: PartitionTarget): void => {
    reset();
    const { destination } = target;
    setField(form, 'name', name);
    setField(form, 'type', destination.type);
    showDestination();
    if (destination.type === 'webhook') {
      setField(form, 'url', destination.url);
      setField(form, 'secret', destination.secret);
    }
    if (destination.type === 'rpc') {
      setField(form, 'rpcBinding', destination.binding);
    }
    if (destination.type === 'service') {
      setField(form, 'binding', destination.binding);
    }
    if (destination.type === 'queue') {
      setField(form, 'queue', destination.queue);
    }
    setField(form, 'maxBatchSize', target.maxBatchSize);
    setField(form, 'maxRetries', target.maxRetries);
    setField(form, 'retryDelaySeconds', target.retryDelaySeconds);
    setField(form, 'attemptTimeoutMs', target.attemptTimeoutMs);
    setField(form, 'maxPerSecond', target.maxPerSecond);
    setField(form, 'maxConcurrency', target.maxConcurrency);
    setField(form, 'startAt', target.startAt);
    setField(form, 'paused', target.paused);
    nameInput.readOnly = true;
    cancel.hidden = false;
    showNotice(notice, `Editing ${name}`);
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  return { form, edit };
};
