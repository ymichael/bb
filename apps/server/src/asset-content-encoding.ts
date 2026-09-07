interface AssetEncodingCandidate {
  encoding: string;
}

function acceptedEncodingQuality(
  acceptEncodingHeader: string | undefined,
  encoding: string,
): number {
  if (acceptEncodingHeader === undefined) {
    return 0;
  }
  let wildcardQuality = 0;
  for (const part of acceptEncodingHeader.split(",")) {
    const [rawName, ...rawParams] = part.trim().split(";");
    const name = rawName?.trim().toLowerCase();
    const qParam = rawParams
      .map((param) => param.trim().toLowerCase())
      .find((param) => param.startsWith("q="));
    const quality =
      qParam === undefined
        ? 1
        : Number.isNaN(Number(qParam.slice(2)))
          ? 1
          : Number(qParam.slice(2));
    if (name === encoding) {
      return quality;
    }
    if (name === "*") {
      wildcardQuality = quality;
    }
  }
  return wildcardQuality;
}

export function rankAcceptedAssetEncodings<
  Candidate extends AssetEncodingCandidate,
>(
  acceptEncodingHeader: string | undefined,
  candidates: readonly Candidate[],
): Candidate[] {
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      quality: acceptedEncodingQuality(
        acceptEncodingHeader,
        candidate.encoding,
      ),
    }))
    .filter((candidate) => candidate.quality > 0)
    .sort(
      (left, right) => right.quality - left.quality || left.index - right.index,
    )
    .map(({ candidate }) => candidate);
}
