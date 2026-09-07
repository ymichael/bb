export interface NamePromptOptions {
  title: string;
  message?: string;
  initialValue: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  onCancel?: () => void;
}
