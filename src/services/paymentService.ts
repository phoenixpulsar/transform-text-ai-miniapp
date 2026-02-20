export interface PaymentConfirmation {
  telegram_chat_id: string;
  tx_hash: string;
  amount_ton: string;
  sender_address: string;
}

export interface PaymentResponse {
  success: boolean;
  credits_granted?: number;
  new_balance?: number;
  message?: string;
  error?: string;
  retry?: boolean;
}

export interface PaymentHistoryItem {
  tx_hash: string;
  verified_tx_hash?: string;
  amount_ton: string;
  credits_granted: number;
  status: string;
  created_at: string;
}

export interface PaymentHistoryResponse {
  payments: PaymentHistoryItem[];
}

export interface RetryPaymentRequest {
  telegram_chat_id: string;
  tx_hash: string;
}

export interface RetryPaymentResponse {
  success: boolean;
  credits_granted: number;
  new_balance: number;
  already_completed?: boolean;
  error?: string;
  retry?: boolean;
}

export interface PaymentStatusResponse {
  status: string;
  credits_granted: number;
  amount_ton: string;
  created_at: string;
}

export class PaymentServiceError extends Error {
  constructor(
    message: string,
    public statusCode?: number,
    public retry: boolean = false
  ) {
    super(message);
    this.name = 'PaymentServiceError';
  }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://transform-text-ai-bot-api-production.up.railway.app';

export async function confirmPayment(data: PaymentConfirmation): Promise<PaymentResponse> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    const responseData = await response.json().catch(() => ({}));

    // Success
    if (response.ok) {
      return responseData;
    }

    // Transaction not found yet - should retry (202)
    if (response.status === 202) {
      throw new PaymentServiceError(
        responseData.message || 'Transaction pending blockchain confirmation',
        202,
        true
      );
    }

    // Duplicate transaction (409)
    if (response.status === 409) {
      throw new PaymentServiceError(
        'This transaction has already been processed',
        409,
        false
      );
    }

    // Rate limit (429)
    if (response.status === 429) {
      throw new PaymentServiceError(
        'Too many requests. Please wait a moment.',
        429,
        false
      );
    }

    // Other errors
    throw new PaymentServiceError(
      responseData.error || `Payment failed: ${response.status}`,
      response.status,
      false
    );
  } catch (error) {
    if (error instanceof PaymentServiceError) {
      throw error;
    }
    
    // Network errors
    throw new PaymentServiceError(
      'Network error. Please check your connection.',
      undefined,
      true
    );
  }
}

export async function retryPaymentVerification(data: RetryPaymentRequest): Promise<RetryPaymentResponse> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/payments/retry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    const responseData = await response.json().catch(() => ({}));

    // Success
    if (response.ok) {
      return responseData;
    }

    // Still not found - continue retrying (202)
    if (response.status === 202) {
      throw new PaymentServiceError(
        'Transaction still pending',
        202,
        true
      );
    }

    // Payment not found (404)
    if (response.status === 404) {
      throw new PaymentServiceError(
        'Payment not found',
        404,
        false
      );
    }

    throw new PaymentServiceError(
      responseData.error || 'Retry failed',
      response.status,
      false
    );
  } catch (error) {
    if (error instanceof PaymentServiceError) {
      throw error;
    }
    
    throw new PaymentServiceError(
      'Network error during retry',
      undefined,
      true
    );
  }
}

export async function getPaymentHistory(telegram_chat_id: string): Promise<PaymentHistoryResponse> {
  const response = await fetch(
    `${API_BASE_URL}/api/payments/history?telegram_chat_id=${encodeURIComponent(telegram_chat_id)}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to fetch payment history: ${response.status}`);
  }

  return response.json();
}

export async function getPaymentStatus(
  telegram_chat_id: string,
  tx_hash: string
): Promise<PaymentStatusResponse | null> {
  const response = await fetch(
    `${API_BASE_URL}/api/payments/status?telegram_chat_id=${encodeURIComponent(telegram_chat_id)}&tx_hash=${encodeURIComponent(tx_hash)}`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `Failed to get payment status: ${response.status}`);
  }

  return response.json();
}