export type HydrationStep = 'users' | 'devices' | 'calls' | 'callEvents' | 'blocks' | 'accountDeletions';
export type HydrationOutcome = {
  status: 'pending' | 'skipped' | 'succeeded' | 'failed';
  loaded: number | null;
  completedAt: string | null;
};
export type Hydration = Record<HydrationStep, HydrationOutcome>;

export function createHydration(enabled: boolean): Hydration {
  return Object.fromEntries(
    ['users', 'devices', 'calls', 'callEvents', 'blocks', 'accountDeletions'].map(step => [
      step,
      { status: enabled ? 'pending' : 'skipped', loaded: null, completedAt: null },
    ])
  ) as Hydration;
}

export function recordHydration(
  state: { hydration?: Hydration },
  step: HydrationStep,
  loaded: number | null
): void {
  if (!state.hydration) return;
  state.hydration[step] = {
    status: loaded === null ? 'failed' : 'succeeded',
    loaded,
    completedAt: new Date().toISOString(),
  };
}
