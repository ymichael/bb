import { useMediaQuery } from "usehooks-ts";

const MOBILE_QUERY = "(max-width: 767px)";

export function useIsMobile() {
  return useMediaQuery(MOBILE_QUERY);
}
