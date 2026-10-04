import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { StyleProp, TextStyle } from 'react-native';
import type { DeliveryState } from '../../messaging/deliveryState';

const LABELS: Record<DeliveryState, string> = {
  queued: 'Queued', sending: 'Sending', sent: 'Sent',
  delivered: 'Delivered', read: 'Read', failed: 'Failed',
};
const INDICATORS: Record<DeliveryState, string> = {
  queued: 'Queued', sending: 'Sending…', sent: '✓', delivered: '✓✓', read: '✓✓ Read', failed: 'Failed',
};

export default function MessageDeliveryIndicator({ status, style, onRetry, onDiscard, testPrefix = 'chat' }: {
  status: DeliveryState; style?: StyleProp<TextStyle>;
  onRetry?: () => void; onDiscard?: () => void; testPrefix?: string;
}) {
  const indicator = <Text style={style} accessibilityLabel={LABELS[status]}
    testID={`${testPrefix}-message-${status === 'queued' || status === 'sending' ? 'pending' : status === 'failed' ? 'failure-label' : 'tick'}`}>
    {INDICATORS[status]}
  </Text>;
  if (status !== 'failed') return indicator;
  return <View>
    {indicator}
    {onRetry ? <Pressable onPress={onRetry} accessibilityRole="button" style={styles.action}
      accessibilityLabel="Retry sending message" testID={`${testPrefix}-message-failed`}>
      <Text style={style}>Retry</Text>
    </Pressable> : null}
    {onDiscard ? <Pressable onPress={onDiscard} accessibilityRole="button" style={styles.action}
      accessibilityLabel="Discard message" testID={`${testPrefix}-message-discard`}>
      <Text style={style}>Discard</Text>
    </Pressable> : null}
  </View>;
}

const styles = StyleSheet.create({
  action: { minHeight: 48, minWidth: 48, justifyContent: 'center' },
});
