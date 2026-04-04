export async function readJson(response: Response): Promise<unknown> {
  return response.json();
}
