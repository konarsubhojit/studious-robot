import renderer, { act } from 'react-test-renderer';

/** Kept outside __tests__ so Jest doesn't discover this shared lifecycle utility as a suite. */
export function installRenderCleanup() {
  const create = renderer.create;
  let trees: ReturnType<typeof create>[] = [];
  beforeEach(() => {
    jest.spyOn(renderer, 'create').mockImplementation((...args) => {
      const tree = create(...args);
      trees.push(tree);
      return tree;
    });
  });
  afterEach(() => {
    act(() => { trees.forEach(tree => tree.unmount()); });
    trees = [];
    jest.restoreAllMocks();
  });
}
