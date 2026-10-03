import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useThemedStyles } from '../ThemeContext';
import { radius, spacing, typography } from '../theme';
import { Sheet } from './primitives';
import type { ThemeColors } from '../theme';
import type { ContactRow } from '../types/directory';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSearchUsers: (query: string) => Promise<ContactRow[]>;
  currentUserId: string;
  excludedIds?: string[];
  adding?: boolean;
  localMock?: boolean;
  onSubmit: (name: string, userIds: string[]) => Promise<unknown>;
};

function canSaveGroup(busy: boolean, count: number, name: string, adding: boolean): boolean {
  if (busy) return false;
  if (adding) return count >= 1;
  return count >= 2 && count <= 15 && Boolean(name.trim());
}

function submitLabel(busy: boolean, adding: boolean, localMock: boolean): string {
  if (busy) return 'Saving…';
  if (adding) return 'Add selected members';
  return localMock ? 'Create local group' : 'Create live group';
}

/** Uses the same authenticated GET /users directory as the direct people picker. */
export default function GroupDirectorySheet({
  visible, onClose, onSearchUsers, currentUserId, excludedIds = [], adding = false, localMock = true, onSubmit,
}: Props) {
  const styles = useThemedStyles(createStyles);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searchError, setSearchError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!visible) {
      setQuery(''); setName(''); setSelected([]); setResults([]); setError(''); setSearchError(false);
    }
  }, [visible]);
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    setLoading(true);
    setSearchError(false);
    const timer = setTimeout(() => {
      onSearchUsers(query.trim()).then(users => {
        if (!cancelled) setResults(users);
      }).catch(() => {
        if (!cancelled) { setResults([]); setSearchError(true); }
      }).finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [visible, query, onSearchUsers, retry]);
  const eligible = [...new Map(results.map(user => [user.userId, user])).values()]
    .filter(user => user.userId !== currentUserId && !excludedIds.includes(user.userId));
  const canSubmit = canSaveGroup(busy, selected.length, name, adding);
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError('');
    try {
      await onSubmit(name.trim(), selected);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to save group');
    } finally { setBusy(false); }
  };
  return (
    <Sheet visible={visible} onClose={() => { if (!busy) onClose(); }}
      title={adding ? 'Add members' : 'New group'} subtitle={localMock ? 'Local mock — changes stay on this device.' :
        'Live group — creation invites selected people on the server.'}
      testID="group-directory-sheet">
      {!adding ? <TextInput style={styles.input} value={name} onChangeText={setName}
        maxLength={128} editable={!busy} placeholder="Group name" accessibilityLabel="Group name" testID="group-name" /> : null}
      <TextInput style={styles.input} value={query} onChangeText={setQuery}
        editable={!busy} placeholder="Search directory" accessibilityLabel="Search group directory" testID="group-directory-query" />
      <Text style={styles.text}>{selected.length} selected{selected.length ? `: ${selected.join(', ')}` : ''}</Text>
      {!adding ? <Text style={styles.text}>Select 2–15 other people</Text> : null}
      {loading ? <ActivityIndicator accessibilityLabel="Loading directory" /> : null}
      {searchError ? <Pressable accessibilityRole="button" onPress={() => setRetry(value => value + 1)}>
        <Text style={styles.text}>Directory unavailable. Tap to retry.</Text>
      </Pressable> : null}
      <FlatList data={eligible} keyExtractor={user => user.userId} keyboardShouldPersistTaps="handled"
        ListEmptyComponent={!loading && !searchError ? <Text style={styles.text}>No eligible people found</Text> : undefined}
        renderItem={({ item }) => <Pressable style={styles.person} disabled={busy}
          accessibilityRole="checkbox" accessibilityLabel={item.userId}
          accessibilityState={{ checked: selected.includes(item.userId), disabled: busy }}
          testID={`group-select-${item.userId}`} onPress={() => setSelected(ids =>
            ids.includes(item.userId) ? ids.filter(id => id !== item.userId) : [...ids, item.userId])}>
          <Text style={styles.text}>{selected.includes(item.userId) ? '✓ ' : ''}{item.userId}</Text>
        </Pressable>} />
      {error ? <Text style={styles.text} accessibilityRole="alert">{error}</Text> : null}
      <Pressable style={styles.person} disabled={!canSubmit} accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit }} testID="group-directory-submit" onPress={() => { void submit(); }}>
        <Text style={styles.text}>{submitLabel(busy, adding, localMock)}</Text>
      </Pressable>
      <View />
    </Sheet>
  );
}

const createStyles = (colors: ThemeColors) => StyleSheet.create({
  input: { ...typography.body, color: colors.onSurface, backgroundColor: colors.surfaceControl, borderRadius: radius.md, padding: spacing.sm },
  text: { ...typography.body, color: colors.onSurface },
  person: { padding: spacing.sm, minHeight: 48, justifyContent: 'center' },
});
