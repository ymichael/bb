import { useEffect, useReducer } from "react";

interface LatestInitialExpandedState {
  isExpanded: boolean;
  isAutoExpanded: boolean;
  wasUserToggled: boolean;
  prevInitialExpanded: boolean;
}

type LatestInitialExpandedAction =
  | {
      type: "sync";
      initialExpanded: boolean;
    }
  | {
      type: "toggle";
    };

export function createLatestInitialExpandedState(
  initialExpanded: boolean,
): LatestInitialExpandedState {
  return {
    isExpanded: initialExpanded,
    isAutoExpanded: initialExpanded,
    wasUserToggled: false,
    prevInitialExpanded: initialExpanded,
  };
}

export function reduceLatestInitialExpandedState(
  state: LatestInitialExpandedState,
  action: LatestInitialExpandedAction,
): LatestInitialExpandedState {
  if (action.type === "toggle") {
    return {
      ...state,
      isExpanded: !state.isExpanded,
      isAutoExpanded: false,
      wasUserToggled: true,
    };
  }

  const nextInitialExpanded = action.initialExpanded;
  let nextState = state;

  if (!state.prevInitialExpanded && nextInitialExpanded) {
    nextState = {
      ...nextState,
      isExpanded: true,
      isAutoExpanded: true,
      wasUserToggled: false,
    };
  }

  if (state.prevInitialExpanded && !nextInitialExpanded) {
    nextState = {
      ...nextState,
      isExpanded:
        state.isAutoExpanded && !state.wasUserToggled
          ? false
          : state.isExpanded,
      isAutoExpanded: false,
      wasUserToggled: false,
    };
  }

  return {
    ...nextState,
    prevInitialExpanded: nextInitialExpanded,
  };
}

export function useLatestInitialExpanded(initialExpanded: boolean): {
  isExpanded: boolean;
  onToggle: () => void;
} {
  const [state, dispatch] = useReducer(
    reduceLatestInitialExpandedState,
    initialExpanded,
    createLatestInitialExpandedState,
  );

  useEffect(() => {
    dispatch({ type: "sync", initialExpanded });
  }, [initialExpanded]);

  return {
    isExpanded: state.isExpanded,
    onToggle: () => {
      dispatch({ type: "toggle" });
    },
  };
}
