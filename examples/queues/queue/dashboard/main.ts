import { api, ApiError, onSignInRequired } from './api';
import {
  dateTime,
  element,
  errorMessage,
  numberField,
  showNotice,
  textField,
} from './dom';
import {
  field,
  handleSubmit,
  limitModeChoices,
  namePattern,
  numberInput,
} from './forms';
import { showQueue } from './queue';

const root = document.querySelector<HTMLElement>('#app') ?? document.body;
let leavePage: (() => void) | undefined;

const showSignIn = (): void => {
  const notice = element('p', { class: 'notice' });
  const form = element(
    'form',
    { class: 'card sign-in' },
    element('h1', {}, 'FIFO queue admin'),
    element(
      'label',
      { class: 'field' },
      element('span', {}, 'Admin token'),
      element('input', {
        type: 'password',
        name: 'token',
        required: true,
        autocomplete: 'current-password',
        autofocus: true,
      })
    ),
    element(
      'div',
      { class: 'actions' },
      element('button', { type: 'submit' }, 'Sign in')
    ),
    notice
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    api('POST', '/api/session', { token: textField(form, 'token') })
      .then(route)
      .catch((error: unknown) =>
        showNotice(notice, errorMessage(error), 'error')
      );
  });
  root.replaceChildren(form);
};

const createQueueForm = (): HTMLFormElement => {
  const notice = element('p', { class: 'notice' });
  const form = element(
    'form',
    { class: 'stack' },
    element(
      'div',
      { class: 'inline' },
      field(
        'Name',
        element('input', {
          name: 'name',
          required: true,
          pattern: namePattern,
          placeholder: 'orders',
        }),
        'Lowercase letters, digits, - or _'
      ),
      field(
        'Min partitions',
        numberInput('min', { min: 1, max: 256, value: 1 })
      ),
      field(
        'Max partitions',
        numberInput('max', { min: 1, max: 256, value: 16 })
      ),
      field(
        'Max concurrency',
        numberInput('maxConcurrency', { min: 1, placeholder: 'none' }),
        'Batches in flight; empty means no limit'
      )
    ),
    limitModeChoices(),
    element(
      'div',
      { class: 'actions' },
      element('button', { type: 'submit' }, 'Create queue')
    ),
    notice
  );

  handleSubmit(form, notice, async () => {
    const name = textField(form, 'name');
    await api('POST', '/api/queues', {
      name,
      settings: {
        partitions: {
          min: numberField(form, 'min') ?? 1,
          max: numberField(form, 'max') ?? 16,
        },
        maxConcurrency: numberField(form, 'maxConcurrency') ?? null,
        limitMode: textField(form, 'limitMode') === 'fast' ? 'fast' : 'strict',
      },
    });
    location.hash = `#/queues/${encodeURIComponent(name)}`;
    return `Created ${name}`;
  });
  return form;
};

const showQueueList = async (): Promise<void> => {
  const list = element(
    'div',
    { class: 'table-wrap' },
    element('p', { class: 'hint' }, 'Loading...')
  );
  root.replaceChildren(
    element('header', { class: 'page-header' }, element('h1', {}, 'Queues')),
    element('section', { class: 'card' }, list),
    element(
      'section',
      { class: 'card' },
      element('h2', {}, 'Create a queue'),
      createQueueForm()
    )
  );

  const queues = (await api('GET', '/api/queues')) as {
    name: string;
    createdAt: number;
  }[];
  if (queues.length === 0) {
    list.replaceChildren(element('p', { class: 'hint' }, 'No queues yet.'));
    return;
  }
  list.replaceChildren(
    element(
      'table',
      {},
      element(
        'thead',
        {},
        element(
          'tr',
          {},
          element('th', {}, 'Name'),
          element('th', {}, 'Created')
        )
      ),
      element(
        'tbody',
        {},
        queues.map((queue) =>
          element(
            'tr',
            {},
            element(
              'td',
              {},
              element(
                'a',
                {
                  href: `#/queues/${encodeURIComponent(queue.name)}`,
                  class: 'mono',
                },
                queue.name
              )
            ),
            element('td', {}, dateTime(queue.createdAt))
          )
        )
      )
    )
  );
};

function route(): void {
  leavePage?.();
  leavePage = undefined;

  const match = /^#\/queues\/([^/]+)$/.exec(location.hash);
  if (match?.[1] !== undefined) {
    leavePage = showQueue(root, decodeURIComponent(match[1]));
    return;
  }
  showQueueList().catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) {
      return;
    }
    root.appendChild(
      element('p', { class: 'notice error' }, errorMessage(error))
    );
  });
}

onSignInRequired(() => {
  leavePage?.();
  leavePage = undefined;
  showSignIn();
});
window.addEventListener('hashchange', route);
route();
