/**
 * Shared UI primitives.
 *
 * Before these existed, avatars were implemented four times, badges three times
 * at three geometries, and every screen re-authored its own rows, section
 * headings, chips, sheets and empty states inside its own `createStyles`. The
 * result was that the same thing looked different depending on where you found
 * it. Screens compose these instead.
 *
 * Every primitive keeps the repository's `createStyles` + `useThemedStyles`
 * convention (a module-constant factory, so the themed-styles cache can key on
 * it) and reads its colours from the palette rather than spelling them.
 */
export { default as Avatar, initialsOf } from './Avatar';
export { default as Badge } from './Badge';
export { default as Chip } from './Chip';
export { default as Divider } from './Divider';
export { default as EmptyState } from './EmptyState';
export { default as FAB } from './FAB';
export { default as Icon } from './Icon';
export { default as IconAction } from './IconAction';
export { default as ListItem } from './ListItem';
export { default as Logotype } from './Logotype';
export { default as SectionHeader } from './SectionHeader';
export { default as SegmentedControl } from './SegmentedControl';
export { default as Sheet } from './Sheet';
export { default as Skeleton, SkeletonRow } from './Skeleton';
export { default as Switch } from './Switch';
export { default as Toast, TOAST_DURATION_MS } from './Toast';

export type { AvatarProps, AvatarSize } from './Avatar';
export type { BadgeProps } from './Badge';
export type { ChipProps } from './Chip';
export type { DividerProps } from './Divider';
export type { EmptyStateProps } from './EmptyState';
export type { FABProps } from './FAB';
export type { IconProps } from './Icon';
export type { IconActionProps } from './IconAction';
export type { ListItemProps } from './ListItem';
export type { LogotypeProps } from './Logotype';
export type { SectionHeaderProps } from './SectionHeader';
export type { SegmentedControlOption, SegmentedControlProps } from './SegmentedControl';
export type { SheetProps } from './Sheet';
export type { SkeletonProps } from './Skeleton';
export type { SwitchProps } from './Switch';
export type { ToastProps, ToastTone } from './Toast';
