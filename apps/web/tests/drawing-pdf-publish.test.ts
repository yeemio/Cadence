import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shallow event regression: state persists across renders; no browser or PDF renderer is simulated.
const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, mutation: 0, uploaded: false,
  options: [] as Array<{ onSuccess?: (value: string) => void }> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[i], (value: unknown) => { hooks.values[i] = value; }];
  },
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: [] }),
  useMutation: (options: { onSuccess?: (value: string) => void }) => {
    const i = hooks.mutation++;
    hooks.options[i] = options;
    return { isPending: false, isSuccess: i === 0 && hooks.uploaded, mutate: vi.fn(),
      reset: () => { hooks.uploaded = false; } };
  },
}));
vi.mock('react-router', () => ({ Link: 'a', useSearchParams: () => [new URLSearchParams('drawingId=part-A'), vi.fn()] }));
vi.mock('../src/data/apiClient', () => ({ request: vi.fn(), requestBytes: vi.fn() }));

const { DrawingLibraryPage } = await import('../src/pages/drawing/DrawingLibraryPage');
type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (node === null || typeof node !== 'object' || !('props' in node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function render(component: () => ReactNode) {
  hooks.cursor = hooks.mutation = 0;
  return elements(component());
}
function field(nodes: Element[], id: string) {
  const node = nodes.find(element => element.props.id === id);
  if (!node) throw new Error(`Missing field ${id}`);
  return node.props;
}
function change(props: Record<string, unknown>, value: string) {
  (props.onChange as (event: unknown) => void)({ target: { value } });
}

beforeEach(() => { hooks.values = []; hooks.options = []; hooks.uploaded = false; });

describe('PDF upload remains bound to its drawing when the publish form is edited', () => {
  function publishForm() {
    const card = render(DrawingLibraryPage).find(element => typeof element.type === 'function' && element.type.name === 'PublishCard')!;
    hooks.values = [];
    const component = () => (card.type as (props: unknown) => ReactNode)(card.props);
    render(component);
    hooks.uploaded = true;
    hooks.options[0]!.onSuccess!('attachment:for-part-A');
    return component;
  }

  it('clears the old drawing file reference and upload receipt before a different drawing can be published', () => {
    const component = publishForm();
    let nodes = render(component);
    expect(field(nodes, 'publish-fileref').value).toBe('attachment:for-part-A');
    change(field(nodes, 'publish-changenote'), 'New drawing revision');
    nodes = render(component);
    change(field(nodes, 'publish-drawing-id'), 'part-B');
    nodes = render(component);
    expect(field(nodes, 'publish-drawing-id').value).toBe('part-B');
    expect(field(nodes, 'publish-fileref').value).toBe('');
    expect(hooks.uploaded).toBe(false);
    expect(nodes.find(element => element.props.type === 'submit')?.props.disabled).toBe(true);
  });

  it('keeps the uploaded reference when only the change note is edited', () => {
    const component = publishForm();
    change(field(render(component), 'publish-changenote'), 'Updated dimensions');
    const nodes = render(component);
    expect(field(nodes, 'publish-fileref').value).toBe('attachment:for-part-A');
    expect(hooks.uploaded).toBe(true);
    expect(nodes.find(element => element.props.type === 'submit')?.props.disabled).toBe(false);
  });
});
