import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { usePaged } from '../pages/admin/shared';

function Harness({ fetcher }) {
  const [status, setStatus] = useState('A');
  const { data } = usePaged(fetcher, { status });
  return (
    <div>
      <button type="button" onClick={() => setStatus('B')}>switch</button>
      <p data-testid="out">{data ? data.label : 'none'}</p>
    </div>
  );
}

test('a slow, older response never overwrites a newer one (filter change race)', async () => {
  const resolvers = {};
  const fetcher = (params) => new Promise((resolve) => (resolvers[params.status] = resolve));
  render(<Harness fetcher={fetcher} />);
  await act(async () => screen.getByText('switch').click());
  await act(async () => resolvers.B({ label: 'result for B' })); // newer answers first
  await act(async () => resolvers.A({ label: 'stale result for A' })); // older answers last
  expect(screen.getByTestId('out')).toHaveTextContent('result for B');
});

test('empty filter values are not sent to the server', async () => {
  const fetcher = vi.fn().mockResolvedValue({ label: 'ok' });
  function H() {
    usePaged(fetcher, { status: '', page: 1, q: null });
    return null;
  }
  await act(async () => render(<H />));
  expect(fetcher).toHaveBeenCalledWith({ page: 1 });
});
