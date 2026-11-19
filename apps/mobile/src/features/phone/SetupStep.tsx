import { useGT } from "gt-react-native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

export function StepRow(props: {
  readonly number: number;
  readonly title: string;
  readonly state: "done" | "current" | "upcoming";
  readonly summary: string | undefined;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const step = { number: props.number, title: props.title };
  return (
    <View
      accessible={props.children === null}
      accessibilityLabel={
        props.state === "done"
          ? gt("Step {number}, {title}, done", step)
          : props.state === "current"
            ? gt("Step {number}, {title}, current step", step)
            : gt("Step {number}, {title}, not started", step)
      }
      className="flex-row gap-3 px-4 py-3"
    >
      <View
        className={cn(
          "mt-0.5 size-6 items-center justify-center rounded-full",
          props.state === "done" && "bg-adaptive-emerald-600-400",
          props.state === "current" && "bg-primary",
          props.state === "upcoming" && "border border-border",
        )}
      >
        {props.state === "done" ? (
          <SymbolView name="checkmark" size={13} tintColorClassName="accent-screen" />
        ) : (
          <Text
            textRole="label"
            className={cn(
              "font-t3-bold",
              props.state === "current" ? "text-primary-foreground" : "text-foreground-muted",
            )}
          >
            {props.number}
          </Text>
        )}
      </View>
      <View className="flex-1 gap-2">
        <View className="flex-row items-center gap-2">
          <View className="flex-1">
            <Text
              className={cn(
                "text-base",
                props.state === "upcoming"
                  ? "text-foreground-muted"
                  : "font-t3-medium text-foreground",
              )}
            >
              {props.title}
            </Text>
            {props.summary && props.state === "done" ? (
              <Text className="text-sm text-foreground-muted">{props.summary}</Text>
            ) : null}
          </View>
          {props.state === "done" ? props.action : null}
        </View>
        {props.children}
      </View>
    </View>
  );
}

export function StepText(props: { readonly children: ReactNode }) {
  return <Text className="text-sm leading-normal text-foreground-muted">{props.children}</Text>;
}
