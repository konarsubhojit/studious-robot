import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

const TABS = [
  { key: 'chats', label: 'Chats', testID: 'app-tab-chats' },
  { key: 'calls', label: 'Calls', testID: 'app-tab-calls' },
  { key: 'settings', label: 'Settings', testID: 'app-tab-settings' },
];

/**
 * Bottom tab bar for the post-registration app shell: Chats / Calls / Settings.
 *
 * A small pill badge (mirroring Lobby's missed-call badge style) is shown on
 * the Chats tab when `unreadCount` is greater than zero.
 *
 * @param {object} props
 * @param {'chats'|'calls'|'settings'} props.activeTab
 * @param {(tab: 'chats'|'calls'|'settings') => void} props.onChangeTab
 * @param {number} [props.unreadCount]
 */
export default function AppTabBar({ activeTab, onChangeTab, unreadCount = 0 }) {
  return (
    <View style={styles.bar} testID="app-tab-bar">
      {TABS.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChangeTab(tab.key)}
            accessibilityRole="button"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: isActive }}
            testID={tab.testID}
            style={styles.tab}
          >
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
            {tab.key === 'chats' && unreadCount > 0 ? (
              <View style={styles.badge} testID="app-tab-chats-badge">
                <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.sm,
  },
  tabLabel: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: colors.textPrimary,
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: '28%',
    backgroundColor: colors.danger,
    borderRadius: 12,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
});
