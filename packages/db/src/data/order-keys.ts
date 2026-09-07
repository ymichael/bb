const ORDER_KEY_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const FIRST_DIGIT = 0;
const LAST_DIGIT = ORDER_KEY_ALPHABET.length - 1;
const MINIMUM_GAP = 1;

interface CreateOrderKeyAfterArgs {
  previousKey: string;
}

interface CreateOrderKeyBetweenArgs {
  nextKey: string | null;
  previousKey: string | null;
}

interface AssertCandidateOrderKeyArgs extends CreateOrderKeyBetweenArgs {
  candidateKey: string;
}

const ORDER_KEY_DIGITS = new Map(
  [...ORDER_KEY_ALPHABET].map((digit, index) => [digit, index]),
);

function requireOrderKeyDigit(index: number): string {
  const digit = ORDER_KEY_ALPHABET[index];
  if (digit === undefined) {
    throw new Error(`Invalid order key digit index: ${index}`);
  }
  return digit;
}

function getOrderKeyDigit(key: string, index: number, fallback: number): number {
  if (index >= key.length) {
    return fallback;
  }

  const digit = ORDER_KEY_DIGITS.get(key[index] ?? "");
  if (digit === undefined) {
    throw new Error(`Invalid order key digit: ${key[index]}`);
  }
  return digit;
}

function assertValidOrderKey(key: string): void {
  if (key.length === 0) {
    throw new Error("Order key cannot be empty");
  }

  for (const digit of key) {
    if (!ORDER_KEY_DIGITS.has(digit)) {
      throw new Error(`Invalid order key digit: ${digit}`);
    }
  }
}

function assertCandidateOrderKey({
  candidateKey,
  nextKey,
  previousKey,
}: AssertCandidateOrderKeyArgs): void {
  if (previousKey !== null && candidateKey <= previousKey) {
    throw new Error("Generated order key must sort after previous order key");
  }
  if (nextKey !== null && candidateKey >= nextKey) {
    throw new Error("Generated order key must sort before next order key");
  }
}

export function createOrderKeyBetween({
  nextKey,
  previousKey,
}: CreateOrderKeyBetweenArgs): string {
  if (previousKey !== null) {
    assertValidOrderKey(previousKey);
  }
  if (nextKey !== null) {
    assertValidOrderKey(nextKey);
  }
  if (previousKey !== null && nextKey !== null && previousKey >= nextKey) {
    throw new Error("Previous order key must sort before next order key");
  }

  let prefix = "";
  let index = 0;

  while (true) {
    const previousDigit =
      previousKey === null
        ? FIRST_DIGIT
        : getOrderKeyDigit(previousKey, index, FIRST_DIGIT);
    const nextDigit =
      nextKey === null
        ? LAST_DIGIT
        : getOrderKeyDigit(nextKey, index, LAST_DIGIT);

    if (nextDigit - previousDigit > MINIMUM_GAP) {
      const midpoint = Math.floor((previousDigit + nextDigit) / 2);
      const candidateKey = `${prefix}${requireOrderKeyDigit(midpoint)}`;

      assertCandidateOrderKey({ candidateKey, previousKey, nextKey });
      return candidateKey;
    }

    prefix = `${prefix}${requireOrderKeyDigit(previousDigit)}`;
    index += 1;
  }
}

export function createOrderKeyAfter({
  previousKey,
}: CreateOrderKeyAfterArgs): string {
  return createOrderKeyBetween({
    previousKey,
    nextKey: null,
  });
}
