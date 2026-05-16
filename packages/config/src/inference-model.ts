export function validateInferenceModel(value: string): string {
  if (/^[^/]+\/[^/]+$/u.test(value)) {
    return value;
  }
  throw new Error(
    `BB_INFERENCE_MODEL must use provider/model format, received "${value}"`,
  );
}
