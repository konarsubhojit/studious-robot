import React from 'react';
import renderer, { act } from 'react-test-renderer';
import PeoplePickerSheet from '../../src/components/PeoplePickerSheet';

/** @param tree @param testID */
const byTestID = (tree: any, testID: string) =>
  tree.root.findAll((n: any) => n.props?.testID === testID);

/** @param tree @param testID */
const first = (tree: any, testID: string) => byTestID(tree, testID)[0] ?? null;

/** @param tree @param testID */
const pressable = (tree: any, testID: string) =>
  byTestID(tree, testID).find((n: any) => typeof n.props?.onPress === 'function');

/** Rows are a composite, a Pressable and a host View; count host nodes. */
const rowCount = (tree: any, testID: string) =>
  byTestID(tree, testID).filter((n: any) => typeof n.type === 'string').length;

const baseProps: any = {
  visible: true,
  onClose: jest.fn(),
  title: 'New chat',
  onSelect: jest.fn(),
};

/** @param props */
function render(props: any = {}) {
  let tree: any;
  act(() => {
    tree = renderer.create(<PeoplePickerSheet {...baseProps} {...props} />);
  });
  return tree;
}

describe('PeoplePickerSheet', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('renders nothing while closed', () => {
    const tree = render({ visible: false });
    expect(first(tree, 'people-picker-search')).toBeNull();
    expect(first(tree, 'people-picker-row')).toBeNull();
  });

  test('offers recent people, grouped by presence, before anything is typed', () => {
    const tree = render({
      conversations: [
        { conversationId: 'c1', peerId: 'user-bob', online: true },
        { conversationId: 'c2', peerId: 'user-carol', online: false },
      ],
    });

    expect(rowCount(tree, 'people-picker-row')).toBe(2);

    const headings = tree.root
      .findAll((n: any) => typeof n.props?.title === 'string' && n.props.variant === 'group')
      .map((n: any) => n.props.title);
    expect(headings).toEqual(['Online now', 'Recent']);
  });

  test('choosing someone closes the sheet before reporting the choice', () => {
    const calls: string[] = [];
    const onClose = jest.fn(() => calls.push('close'));
    const onSelect = jest.fn(() => calls.push('select'));

    const tree = render({
      conversations: [{ conversationId: 'c1', peerId: 'user-bob', online: true }],
      onClose,
      onSelect,
    });

    act(() => {
      pressable(tree, 'people-picker-row').props.onPress();
    });

    expect(onSelect).toHaveBeenCalledWith('user-bob');
    // Closing first keeps the sheet's exit from racing the caller's navigation.
    expect(calls).toEqual(['close', 'select']);
  });

  test('debounces typing into a single directory request', async () => {
    jest.useFakeTimers();
    const onSearchUsers = jest.fn().mockResolvedValue([{ userId: 'user-dave', online: true }]);
    const tree = render({ onSearchUsers });

    const input = first(tree, 'people-picker-search');
    await act(async () => {
      input.props.onChangeText('dav');
    });
    expect(onSearchUsers).not.toHaveBeenCalled();

    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSearchUsers).toHaveBeenCalledWith('dav');
    expect(rowCount(tree, 'people-picker-row')).toBe(1);
  });

  test('a directory failure says so instead of claiming there are no matches', async () => {
    jest.useFakeTimers();
    const onSearchUsers = jest.fn().mockRejectedValue(new Error('unreachable'));
    const tree = render({ onSearchUsers });

    await act(async () => {
      first(tree, 'people-picker-search').props.onChangeText('dave');
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(first(tree, 'people-picker-error')).not.toBeNull();
    expect(first(tree, 'people-picker-empty')).toBeNull();
  });

  test('an empty directory result reads as no matches for the query', async () => {
    jest.useFakeTimers();
    const onSearchUsers = jest.fn().mockResolvedValue([]);
    const tree = render({ onSearchUsers });

    await act(async () => {
      first(tree, 'people-picker-search').props.onChangeText('nobody');
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    const empty = byTestID(tree, 'people-picker-empty').find(
      (n: any) => typeof n.type === 'function',
    );
    expect(empty.props.title).toBe('No matching people');
    expect(first(tree, 'people-picker-error')).toBeNull();
  });

  test('a stale response cannot overwrite a newer one', async () => {
    jest.useFakeTimers();
    let resolveFirst: (rows: any[]) => void = () => {};
    const onSearchUsers = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce([{ userId: 'user-zoe', online: true }]);

    const tree = render({ onSearchUsers });

    await act(async () => {
      first(tree, 'people-picker-search').props.onChangeText('a');
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
    });

    await act(async () => {
      first(tree, 'people-picker-search').props.onChangeText('zo');
    });
    await act(async () => {
      jest.advanceTimersByTime(300);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The first request finishes last, with results for a query the user has
    // already moved on from.
    await act(async () => {
      resolveFirst([{ userId: 'user-anna', online: false }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    const labels = tree.root
      .findAll((n: any) => n.props?.testID === 'people-picker-row' && typeof n.type === 'function')
      .map((n: any) => n.props.title);
    expect(labels).toEqual(['user-zoe']);
  });

  test('clears the query when it is dismissed, so it reopens fresh', async () => {
    jest.useFakeTimers();
    const onSearchUsers = jest.fn().mockResolvedValue([]);
    let tree: any;
    act(() => {
      tree = renderer.create(
        <PeoplePickerSheet {...baseProps} onSearchUsers={onSearchUsers} />,
      );
    });

    await act(async () => {
      first(tree, 'people-picker-search').props.onChangeText('dave');
    });
    expect(first(tree, 'people-picker-search').props.value).toBe('dave');

    await act(async () => {
      tree.update(<PeoplePickerSheet {...baseProps} visible={false} onSearchUsers={onSearchUsers} />);
    });
    await act(async () => {
      tree.update(<PeoplePickerSheet {...baseProps} visible onSearchUsers={onSearchUsers} />);
    });

    expect(first(tree, 'people-picker-search').props.value).toBe('');
  });
});
