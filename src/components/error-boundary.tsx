import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { recordError } from '@/lib/crash-log';
import { font, palette } from '@/theme';

/** Catches React render-tree errors thrown inside `children` and
 *  routes them through crash-log. The fallback UI links to
 *  /debug-crash so the user can read what blew up.
 *
 *  Limitations: doesn't catch event-handler errors, async errors, or
 *  errors in the boundary itself — for those, see crash-log.initCrashLog. */
interface Props {
  children: React.ReactNode;
  source: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    recordError(error, this.props.source, {
      componentStack: info.componentStack,
    });
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return <Fallback error={this.state.error} onReset={this.reset} />;
    }
    return this.props.children;
  }
}

function Fallback({ error, onReset }: { error: Error; onReset: () => void }) {
  const router = useRouter();
  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.head}>
        <Ionicons name="warning" size={28} color={palette.coral} />
        <Text style={styles.title}>This screen crashed</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.msg}>{error.message}</Text>
        {error.stack ? (
          <Text style={styles.stack} selectable>
            {error.stack}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.actions}>
        <Pressable
          style={[styles.btn, { borderColor: palette.lime }]}
          onPress={() => router.push('/debug-crash')}
        >
          <Text style={[styles.btnText, { color: palette.lime }]}>
            Open crash log
          </Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { borderColor: palette.text2 }]}
          onPress={onReset}
        >
          <Text style={[styles.btnText, { color: palette.text }]}>
            Try again
          </Text>
        </Pressable>
        <Pressable
          style={[styles.btn, { borderColor: palette.text2 }]}
          onPress={() => router.replace('/')}
        >
          <Text style={[styles.btnText, { color: palette.text }]}>
            Back to home
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.bg },
  head: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontFamily: font.displayHeavy,
    fontSize: 20,
    color: palette.text,
    fontWeight: '800',
  },
  msg: {
    fontFamily: font.bodyBold,
    fontSize: 14,
    color: palette.coral,
    marginBottom: 12,
  },
  stack: {
    fontFamily: font.mono,
    fontSize: 11,
    color: palette.text2,
    lineHeight: 16,
  },
  actions: {
    padding: 16,
    gap: 8,
  },
  btn: {
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  btnText: {
    fontFamily: font.bodyBold,
    fontSize: 14,
    fontWeight: '700',
  },
});
