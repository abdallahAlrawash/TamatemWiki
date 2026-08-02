import { loadEnv } from './loadEnv.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

function getOutputText(responseJson) {
  if (typeof responseJson.output_text === 'string') {
    return responseJson.output_text;
  }

  const textParts = [];

  for (const item of responseJson.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === 'output_text' && typeof content.text === 'string') {
        textParts.push(content.text);
      }
    }
  }

  return textParts.join('\n');
}

export async function createStructuredResponse({
  input,
  model = process.env.OPENAI_SCRIPT_MODEL || 'gpt-5.2',
  schema,
  schemaName,
}) {
  await loadEnv();

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is missing. Add it to .env first.');
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input,
      text: {
        format: {
          type: 'json_schema',
          name: schemaName,
          strict: true,
          schema,
        },
      },
    }),
  });

  const responseJson = await response.json();

  if (!response.ok) {
    const message = responseJson.error?.message || `OpenAI request failed with ${response.status}`;
    throw new Error(message);
  }

  const outputText = getOutputText(responseJson);

  return {
    id: responseJson.id,
    model: responseJson.model,
    outputText,
    parsed: JSON.parse(outputText),
    raw: responseJson,
  };
}
