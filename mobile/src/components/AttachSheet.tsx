import { ListItem, Sheet } from './primitives';

/** The three ways a message can carry something other than text. */
const OPTIONS: ReadonlyArray<{
  kind: 'photo' | 'camera' | 'file';
  label: string;
  hint: string;
  icon: string;
}> = [
  { kind: 'photo', label: 'Photo', hint: 'Choose a picture already on this device', icon: 'settingsMedia' },
  { kind: 'camera', label: 'Camera', hint: 'Take a new picture now', icon: 'callTypeVideo' },
  { kind: 'file', label: 'File', hint: 'Choose any other file to send', icon: 'attachmentAttach' },
];

/**
 * The composer's attachment choices.
 *
 * Was a private copy of the modal/backdrop/scrim arrangement — at a different
 * corner radius from `AudioOutputMenu`'s copy, with no grabber and no
 * home-indicator padding — and three hand-rolled rows whose icons were bare
 * emoji. It is now the shared `Sheet` with shared `ListItem` rows, so it looks
 * and behaves like every other sheet in the app.
 */
export default function AttachSheet({
  visible,
  onClose,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (kind: 'photo' | 'camera' | 'file') => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} title="Send" testID="chat-attach-sheet">
      {OPTIONS.map(option => (
        <ListItem
          key={option.kind}
          title={option.label}
          subtitle={option.hint}
          icon={option.icon}
          onPress={() => {
            onClose();
            onSelect(option.kind);
          }}
          accessibilityLabel={option.label}
          accessibilityHint={option.hint}
          testID={`chat-attach-option-${option.kind}`}
        />
      ))}
    </Sheet>
  );
}
