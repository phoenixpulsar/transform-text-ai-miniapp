import { useState, useCallback, useEffect, useRef } from "react";
import type { FC } from "react";
import { Link } from "react-router-dom";
import { useTonConnectUI, useTonWallet } from "@tonconnect/ui-react";
import { TonConnectButton } from "@tonconnect/ui-react";
import {
  Button,
  Cell,
  List,
  Placeholder,
  Section,
  Spinner,
  Text,
} from "@telegram-apps/telegram-ui";
import { initData, useSignal } from "@tma.js/sdk-react";

import { Page } from "@/components/Page.tsx";
import { bem } from "@/css/bem.ts";
import {
  confirmPayment,
  retryPaymentVerification,
  PaymentServiceError,
} from "@/services/paymentService.ts";
import { extractTransactionHash, toRawAddress } from "@/utils/tonUtils.ts";

import "./PurchasePage.css";

const [, e] = bem("purchase-page");

interface CreditPack {
  id: string;
  price: number;
  credits: number;
  tonAmount: string;
}

const CREDIT_PACKS: CreditPack[] = [
  { id: "1", price: 1, credits: 30, tonAmount: "1000000000" },
  { id: "5", price: 5, credits: 200, tonAmount: "5000000000" },
  { id: "10", price: 10, credits: 500, tonAmount: "10000000000" },
  { id: "20", price: 20, credits: 1500, tonAmount: "20000000000" },
];

const RECIPIENT_WALLET_ADDRESS =
  "UQDtOHseLnogLlsj-Uu6HqsI2XuXMCZCT9SE0iklaaifxAE8";

type PageState = "default" | "loading" | "success" | "error" | "verifying";

interface PaymentInfo {
  txHash: string;
  amount: number;
  credits: number;
}

// Retry configuration
const INITIAL_RETRY_DELAY = 3000; // 3 seconds
const MAX_RETRY_DELAY = 15000; // 15 seconds
const MAX_RETRIES = 30; // More retries with shorter delays
const BLOCKCHAIN_CONFIRMATION_TIME = 5000; // Wait 5s before first retry (reduced from 30s)

export const PurchasePage: FC = () => {
  const wallet = useTonWallet();
  const [tonConnectUI] = useTonConnectUI();
  const initDataState = useSignal(initData.state);

  const [pageState, setPageState] = useState<PageState>("default");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [selectedPack, setSelectedPack] = useState<CreditPack | null>(null);
  const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null);
  const [retryCount, setRetryCount] = useState<number>(0);
  const [timeRemaining, setTimeRemaining] = useState<number>(0);
  const [isManualRetrying, setIsManualRetrying] = useState<boolean>(false);

  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const chatId = initDataState?.user?.id?.toString() || "";

  // Cleanup function
  const cleanup = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    setRetryCount(0);
    setTimeRemaining(0);
  }, []);

  // Exponential backoff calculation
  const getRetryDelay = (attemptNumber: number): number => {
    const delay = Math.min(
      INITIAL_RETRY_DELAY * Math.pow(1.5, attemptNumber),
      MAX_RETRY_DELAY,
    );
    return Math.floor(delay);
  };

  // Retry verification logic
  const attemptVerification = useCallback(
    async (txHash: string, attemptNumber: number): Promise<boolean> => {
      if (!chatId || attemptNumber >= MAX_RETRIES) {
        setPageState("error");
        setErrorMessage(
          "Verification timeout. Please contact support with your transaction ID.",
        );
        return false;
      }

      try {
        const result = await retryPaymentVerification({
          telegram_chat_id: chatId,
          tx_hash: txHash,
        });

        if (result.success || result.already_completed) {
          cleanup();
          setPageState("success");
          return true;
        }

        return false;
      } catch (error) {
        if (error instanceof PaymentServiceError && error.retry) {
          // Schedule next retry with exponential backoff
          const delay = getRetryDelay(attemptNumber);
          setTimeRemaining(Math.ceil(delay / 1000));

          // Update countdown every second
          countdownIntervalRef.current = setInterval(() => {
            setTimeRemaining((prev) => Math.max(0, prev - 1));
          }, 1000);

          retryTimeoutRef.current = setTimeout(() => {
            if (countdownIntervalRef.current) {
              clearInterval(countdownIntervalRef.current);
            }
            setRetryCount(attemptNumber + 1);
            attemptVerification(txHash, attemptNumber + 1);
          }, delay);

          return false;
        }

        // Non-retryable error
        cleanup();
        setPageState("error");
        setErrorMessage(
          error instanceof Error ? error.message : "Verification failed",
        );
        return false;
      }
    },
    [chatId, cleanup],
  );

  // Handle purchase
  const handlePurchase = useCallback(
    async (pack: CreditPack) => {
      if (!chatId) {
        setErrorMessage("Unable to identify user. Please restart the app.");
        setPageState("error");
        return;
      }

      if (!wallet) {
        setErrorMessage("Please connect your wallet first.");
        setPageState("error");
        return;
      }

      cleanup();
      setSelectedPack(pack);
      setPageState("loading");
      setErrorMessage("");
      setPaymentInfo(null);

      let txResult: { boc: string } | null = null;

      try {
        // Send transaction through wallet
        const transaction = {
          validUntil: Math.floor(Date.now() / 1000) + 360, // 6 minutes
          messages: [
            {
              address: RECIPIENT_WALLET_ADDRESS,
              amount: pack.tonAmount,
            },
          ],
        };

        txResult = await tonConnectUI.sendTransaction(transaction);

        // Extract the actual transaction hash from BOC
        const txHash = extractTransactionHash(txResult.boc);

        setPaymentInfo({
          txHash: txHash,
          amount: pack.price,
          credits: pack.credits,
        });

        // Convert sender address to raw format for consistent comparison with TON API
        const senderAddress = toRawAddress(wallet.account.address);

        // Always go to verifying state first - never show success immediately
        // This ensures we verify the payment is actually recorded before showing success
        setPageState("verifying");

        try {
          // Register the payment with the backend
          await confirmPayment({
            telegram_chat_id: chatId,
            tx_hash: txHash,
            amount_ton: pack.price.toString(),
            sender_address: senderAddress,
          });

          // Even if backend returns success, verify with retry endpoint to be sure
          // Wait a moment then verify
          setTimeout(() => {
            setRetryCount(0);
            attemptVerification(txHash, 0);
          }, BLOCKCHAIN_CONFIRMATION_TIME);
        } catch (error) {
          // If transaction not found yet (202), start retry loop
          if (error instanceof PaymentServiceError && error.retry) {
            // Wait for blockchain confirmation before starting retries
            setTimeout(() => {
              setRetryCount(0);
              attemptVerification(txHash, 0);
            }, BLOCKCHAIN_CONFIRMATION_TIME);
            return;
          }

          // Other errors - but transaction was sent, so go to error state with tx info
          throw error;
        }
      } catch (error) {
        cleanup();

        if (txResult) {
          // Transaction was sent but verification failed
          // Extract the actual transaction hash from BOC for error reporting
          const errorTxHash = extractTransactionHash(txResult.boc);
          setPaymentInfo({
            txHash: errorTxHash,
            amount: pack.price,
            credits: pack.credits,
          });
          setPageState("error");
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Transaction sent but verification failed. Please contact support.",
          );
        } else {
          // Transaction was not sent (user cancelled or error)
          setPageState("error");
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Transaction failed. Please try again.",
          );
        }
      }
    },
    [chatId, wallet, tonConnectUI, cleanup, attemptVerification],
  );

  // Reset to default state
  const handleReset = useCallback(() => {
    cleanup();
    setPageState("default");
    setErrorMessage("");
    setSelectedPack(null);
    setPaymentInfo(null);
  }, [cleanup]);

  // Disconnect wallet
  const handleDisconnect = useCallback(async () => {
    cleanup();
    await tonConnectUI.disconnect();
  }, [tonConnectUI, cleanup]);

  // Manual retry handler
  const handleManualRetry = useCallback(async () => {
    if (!paymentInfo || !chatId || isManualRetrying) return;

    setIsManualRetrying(true);
    try {
      const result = await retryPaymentVerification({
        telegram_chat_id: chatId,
        tx_hash: paymentInfo.txHash,
      });

      if (result.success || result.already_completed) {
        cleanup();
        setPageState("success");
      }
    } catch (error) {
      if (error instanceof PaymentServiceError && !error.retry) {
        setErrorMessage(error.message);
      }
    } finally {
      setIsManualRetrying(false);
    }
  }, [paymentInfo, chatId, isManualRetrying, cleanup]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  // Landing page (no wallet connected)
  if (!wallet) {
    return (
      <Page back={false}>
        <div className={e("landing")}>
          <div className={e("landing-content")}>
            <div className={e("hero-icon")}>
              <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
                <circle cx="40" cy="40" r="40" fill="url(#gradient1)" />
                <path
                  d="M25 35L40 25L55 35V50L40 60L25 50V35Z"
                  stroke="white"
                  strokeWidth="2.5"
                  fill="none"
                />
                <path
                  d="M40 25V60M25 35L55 50M55 35L25 50"
                  stroke="white"
                  strokeWidth="2"
                  strokeOpacity="0.6"
                />
                <defs>
                  <linearGradient id="gradient1" x1="0" y1="0" x2="80" y2="80">
                    <stop stopColor="#0098EA" />
                    <stop offset="1" stopColor="#0057B8" />
                  </linearGradient>
                </defs>
              </svg>
            </div>

            <h1 className={e("hero-title")}>AI Text Transformation</h1>
            <p className={e("hero-subtitle")}>
              Perfect your writing with AI-powered grammar and spelling
              correction. Fast, secure, powered by TON.
            </p>

            <div className={e("features")}>
              <div className={e("feature")}>
                <span className={e("feature-icon")}>⚡</span>
                <div className={e("feature-text")}>
                  <strong>Instant Results</strong>
                  <span>Transform text in seconds</span>
                </div>
              </div>
              <div className={e("feature")}>
                <span className={e("feature-icon")}>🔒</span>
                <div className={e("feature-text")}>
                  <strong>Secure Payments</strong>
                  <span>TON blockchain</span>
                </div>
              </div>
              <div className={e("feature")}>
                <span className={e("feature-icon")}>✨</span>
                <div className={e("feature-text")}>
                  <strong>AI-Powered</strong>
                  <span>Grammar & spelling correction</span>
                </div>
              </div>
            </div>

            <div className={e("cta-section")}>
              <Text className={e("cta-text")}>
                Connect your wallet to get started
              </Text>
              <TonConnectButton className={e("cta-button")} />
            </div>

            <p className={e("trust-badge")}>Trusted by thousands worldwide</p>
          </div>
        </div>
      </Page>
    );
  }

  // Loading state
  if (pageState === "loading") {
    return (
      <Page back={false}>
        <Placeholder
          header="Sending Transaction"
          description="Please confirm in your wallet..."
        >
          <Spinner size="l" />
        </Placeholder>
      </Page>
    );
  }

  // Verifying state
  if (pageState === "verifying") {
    const creditsAmount = selectedPack?.credits || paymentInfo?.credits;
    return (
      <Page back={false}>
        <Placeholder
          header="Verifying Payment"
          description={
            <>
              <Text>
                Your payment of {selectedPack?.price || paymentInfo?.amount} TON
                was sent successfully.
              </Text>
              <Spinner size="m" style={{ margin: "16px 0" }} />
              <Text>
                Waiting for blockchain confirmation...
                {retryCount > 0 &&
                  ` (Attempt ${retryCount + 1}/${MAX_RETRIES})`}
              </Text>
              {timeRemaining > 0 && (
                <Text className={e("countdown")}>
                  Next check in {timeRemaining}s
                </Text>
              )}
              <Text className={e("info-text")}>
                {creditsAmount} credits will be added once verified.
              </Text>
              {paymentInfo && (
                <Text className={e("tx-info")}>
                  TX: {paymentInfo.txHash.slice(0, 16)}...
                </Text>
              )}
              <Button
                size="s"
                mode="outline"
                onClick={handleManualRetry}
                disabled={isManualRetrying}
                style={{ marginTop: "16px" }}
              >
                {isManualRetrying ? "Checking..." : "Check Now"}
              </Button>
            </>
          }
        />
      </Page>
    );
  }

  // Success state
  if (pageState === "success") {
    const creditsAmount = selectedPack?.credits || paymentInfo?.credits;
    return (
      <Page back={false}>
        <Placeholder
          header="Payment Successful! 🎉"
          description={
            <>
              <Text>{creditsAmount} credits added to your account.</Text>
              <Text>Return to the bot to start using your credits.</Text>
              <Button onClick={handleReset} style={{ marginTop: "16px" }}>
                Purchase More Credits
              </Button>
            </>
          }
        />
      </Page>
    );
  }

  // Error state
  if (pageState === "error") {
    return (
      <Page back={false}>
        <Placeholder
          header="Payment Issue"
          description={
            <>
              <Text className={e("error-text")}>{errorMessage}</Text>
              {paymentInfo && (
                <>
                  <Text className={e("tx-info")}>
                    Transaction ID: {paymentInfo.txHash.slice(0, 16)}...
                  </Text>
                  <Text className={e("support-text")}>
                    Please contact support with this transaction ID if credits
                    are not added within 10 minutes.
                  </Text>
                </>
              )}
              <Button onClick={handleReset} style={{ marginTop: "16px" }}>
                Try Again
              </Button>
            </>
          }
        />
      </Page>
    );
  }

  // Default state - show purchase options
  return (
    <Page back={false}>
      <List>
        <Section header="Purchase Credits">
          {CREDIT_PACKS.map((pack) => (
            <Cell
              key={pack.id}
              subtitle={`${pack.credits} credits`}
              after={
                <Button size="s" onClick={() => handlePurchase(pack)}>
                  ${pack.price}
                </Button>
              }
            >
              ${pack.price} Pack
            </Cell>
          ))}
        </Section>

        <Section footer="Payments via TON blockchain. Credits added immediately after confirmation.">
          <Cell
            subtitle={`${wallet.account.address.slice(0, 8)}...${wallet.account.address.slice(-6)}`}
            after={
              <Button size="s" mode="outline" onClick={handleDisconnect}>
                Disconnect
              </Button>
            }
          >
            Connected Wallet
          </Cell>

          <Link to="/purchase-history" className={e("history-link")}>
            <Cell after={<span>›</span>}>View Purchase History</Cell>
          </Link>
        </Section>
      </List>
    </Page>
  );
};
