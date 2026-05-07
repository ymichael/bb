import { FormError } from "./form-error";

export default {
  title: "Primitives/FormError",
};

export function Message() {
  return (
    <div className="grid max-w-md gap-3 p-6">
      <FormError message="Project name is required." />
      <FormError
        message="Workspace path must be inside an existing directory."
        className="border-destructive/40"
      />
    </div>
  );
}

export function Empty() {
  return (
    <div className="grid max-w-md gap-3 p-6 text-sm text-muted-foreground">
      <FormError message={null} />
      No validation error
    </div>
  );
}
