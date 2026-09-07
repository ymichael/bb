import { forwardRef } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { cn } from "./cn";
import { useInputFieldProps, type InputFieldOptions } from "./Input";

export interface TextAreaProps extends TextInputProps, InputFieldOptions {}

export const TextArea = forwardRef<TextInput, TextAreaProps>(function TextArea(
  { invalid, editable = true, mono, grouped, className, style, ...props },
  ref,
) {
  const field = useInputFieldProps({
    invalid,
    mono,
    grouped,
    editable,
    className: cn("min-h-[60px] py-2.5", className),
  });
  return (
    <TextInput
      ref={ref}
      multiline
      textAlignVertical="top"
      editable={editable}
      {...field}
      clearButtonMode="never"
      style={[field.style, style]}
      {...props}
    />
  );
});
