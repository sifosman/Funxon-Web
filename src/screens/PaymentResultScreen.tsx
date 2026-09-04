import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { colors, radii, spacing, typography } from '../theme';
import type { ProfileStackParamList } from '../navigation/ProfileNavigator';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../auth/AuthContext';
import { SUPPORT_WHATSAPP } from '../utils/env';
import { openExternalUrl } from '../utils/openUrl';
import { useIsDesktop } from '../hooks/useIsDesktop';

type PaymentStatus = 'success' | 'pending' | 'failed' | 'cancelled';

type RouteParams = {
  status?: PaymentStatus | 'cancel';
  productType?: 'vendor' | 'venue';
  planName?: string;
  amountLabel?: string;
};

const RECENT_WINDOW_MS = 15 * 60 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function PaymentResultScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ProfileStackParamList>>();
  const route = useRoute();
  const { user } = useAuth();
  const isDesktop = useIsDesktop();

  const params = (route.params ?? {}) as RouteParams;
  const productType = params.productType === 'venue' ? 'venue' : params.productType === 'vendor' ? 'vendor' : undefined;
  const planName = params.planName;
  const amountLabel = params.amountLabel;

  // 'success' and 'pending' (and undefined deep links) are verified against the
  // database before showing the success screen — the ITN is the source of truth.
  const claimedStatus: PaymentStatus =
    params.status === 'failed'
      ? 'failed'
      : params.status === 'cancelled' || params.status === 'cancel'
        ? 'cancelled'
        : 'pending';

  const [verified, setVerified] = useState<PaymentStatus | null>(
    claimedStatus === 'failed' || claimedStatus === 'cancelled' ? claimedStatus : null,
  );
  const [checking, setChecking] = useState(claimedStatus === 'pending');
  const pollAborted = useRef(false);

  const checkSubscriptionNow = useCallback(async (): Promise<PaymentStatus> => {
    if (!user?.id) return 'pending';
    const tables = productType ? [productType === 'venue' ? 'venues' : 'vendors'] : ['vendors', 'venues'];
    for (const table of tables) {
      const { data } = await supabase
        .from(table)
        .select('subscription_status, subscription_started_at')
        .eq('user_id', user.id)
        .maybeSingle();
      const row = data as any;
      if (
        row?.subscription_status === 'active' &&
        row?.subscription_started_at &&
        Date.now() - new Date(row.subscription_started_at).getTime() < RECENT_WINDOW_MS
      ) {
        return 'success';
      }
    }
    return 'pending';
  }, [user?.id, productType]);

  const runVerification = useCallback(async (timeoutMs: number) => {
    setChecking(true);
    pollAborted.current = false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !pollAborted.current) {
      const result = await checkSubscriptionNow();
      if (pollAborted.current) return;
      if (result === 'success') {
        setVerified('success');
        setChecking(false);
        return;
      }
      await sleep(2500);
    }
    if (!pollAborted.current) {
      setVerified('pending');
      setChecking(false);
    }
  }, [checkSubscriptionNow]);

  useEffect(() => {
    if (claimedStatus !== 'pending') return;
    runVerification(params.status === 'success' ? 20000 : 45000);
    return () => {
      pollAborted.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const status = verified ?? claimedStatus;

  const plansScreen = productType === 'venue' ? 'VenueListingPlans' : 'SubscriptionPlans';
  const portfolioScreen = productType === 'venue' ? 'UpdateVenuePortfolio' : 'UpdateVendorPortfolio';
  const whatsappUrl = `https://wa.me/${SUPPORT_WHATSAPP.replace(/[^0-9]/g, '')}?text=${encodeURIComponent('Hi Funxon support, I need help with a subscription payment.')}`;

  const renderIcon = (name: keyof typeof MaterialIcons.glyphMap, bg: string, color: string) => (
    <View
      style={{
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: spacing.lg,
      }}
    >
      <MaterialIcons name={name} size={48} color={color} />
    </View>
  );

  const primaryButton = (label: string, onPress: () => void, variant: 'primary' | 'outline' = 'primary') => (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        backgroundColor: variant === 'primary' ? colors.primary : colors.surface,
        borderWidth: variant === 'primary' ? 0 : 1,
        borderColor: colors.primary,
        borderRadius: radii.md,
        paddingVertical: spacing.md,
        alignItems: 'center',
        marginBottom: spacing.sm,
      }}
    >
      <Text
        style={{
          ...typography.bodySemiBold,
          color: variant === 'primary' ? colors.primaryForeground : colors.primary,
        }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );

  const containerStyle = {
    flex: 1,
    backgroundColor: isDesktop ? colors.surfaceBg : colors.background,
  } as const;

  const content = (() => {
    if (status === 'pending' || (status === null && checking)) {
      return (
        <View style={{ alignItems: 'center', justifyContent: 'center', flex: 1, padding: spacing.xl }}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={{ ...typography.titleLarge, color: colors.textPrimary, marginTop: spacing.lg, textAlign: 'center' }}>
            Verifying your payment…
          </Text>
          <Text style={{ ...typography.body, color: colors.textMuted, marginTop: spacing.sm, textAlign: 'center' }}>
            This usually only takes a few seconds. You can safely leave this screen — we will update your subscription as soon as PayFast confirms the payment.
          </Text>
          <View style={{ alignSelf: 'stretch', marginTop: spacing.xl }}>
            <TouchableOpacity
              onPress={() => runVerification(15000)}
              activeOpacity={0.85}
              style={{
                backgroundColor: colors.primary,
                borderRadius: radii.md,
                paddingVertical: spacing.md,
                alignItems: 'center',
                marginBottom: spacing.sm,
              }}
            >
              <Text style={{ ...typography.bodySemiBold, color: colors.primaryForeground }}>Refresh Status</Text>
            </TouchableOpacity>
            {primaryButton('Go to Billing', () => navigation.navigate('Billing'), 'outline')}
            {primaryButton('Contact Support', () => openExternalUrl(whatsappUrl), 'outline')}
          </View>
        </View>
      );
    }

    if (status === 'success') {
      return (
        <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center', padding: spacing.xl }}>
          {renderIcon('check-circle', '#E8F7EE', '#1B9E4B')}
          <Text style={{ ...typography.titleLarge, color: colors.textPrimary, textAlign: 'center' }}>
            Payment Successful!
          </Text>
          <Text style={{ ...typography.body, color: colors.textMuted, marginTop: spacing.sm, textAlign: 'center' }}>
            {planName ? `Your ${planName} subscription is now active.` : 'Your subscription is now active.'}
            {amountLabel ? ` Amount paid: ${amountLabel}.` : ''}
            {' '}A confirmation email is on its way to you.
          </Text>
          <View style={{ alignSelf: 'stretch', marginTop: spacing.xl }}>
            {primaryButton('Go to My Portfolio', () => navigation.reset({ index: 0, routes: [{ name: portfolioScreen }] }))}
            {primaryButton('Go to Billing', () => navigation.navigate('Billing'), 'outline')}
          </View>
        </View>
      );
    }

    if (status === 'cancelled') {
      return (
        <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center', padding: spacing.xl }}>
          {renderIcon('info', '#FFF6E5', '#B45309')}
          <Text style={{ ...typography.titleLarge, color: colors.textPrimary, textAlign: 'center' }}>
            Payment Cancelled
          </Text>
          <Text style={{ ...typography.body, color: colors.textMuted, marginTop: spacing.sm, textAlign: 'center' }}>
            You cancelled the checkout — no payment was taken and your subscription has not changed. You can try again whenever you are ready.
          </Text>
          <View style={{ alignSelf: 'stretch', marginTop: spacing.xl }}>
            {primaryButton('Try Again', () => navigation.navigate(plansScreen as any))}
            {primaryButton('Back to Account', () => navigation.navigate('AccountMain'), 'outline')}
          </View>
        </View>
      );
    }

    // failed
    return (
      <View style={{ alignItems: 'center', flex: 1, justifyContent: 'center', padding: spacing.xl }}>
        {renderIcon('error', '#FDECEC', colors.destructive)}
        <Text style={{ ...typography.titleLarge, color: colors.textPrimary, textAlign: 'center' }}>
          Payment Failed
        </Text>
        <Text style={{ ...typography.body, color: colors.textMuted, marginTop: spacing.sm, textAlign: 'center' }}>
          Unfortunately the payment did not go through. Common causes include insufficient funds, an incorrect PIN, or the card being declined by your bank. Your subscription has not been activated and you have not been charged.
        </Text>
        <View style={{ alignSelf: 'stretch', marginTop: spacing.xl }}>
          {primaryButton('Try Again', () => navigation.navigate(plansScreen as any))}
          {primaryButton('Contact Support', () => openExternalUrl(whatsappUrl), 'outline')}
          {primaryButton('Go to Billing', () => navigation.navigate('Billing'), 'outline')}
        </View>
      </View>
    );
  })();

  return (
    <View style={containerStyle}>
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          paddingBottom: spacing.xl,
          paddingHorizontal: isDesktop ? 0 : spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={isDesktop ? { maxWidth: 560, width: '100%', alignSelf: 'center' } : undefined}>
          {content}
        </View>
      </ScrollView>
    </View>
  );
}
