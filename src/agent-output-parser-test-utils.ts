import { AGENT_OUTPUT_PARSER_FIXTURES } from "./agent-output-parser-fixtures.js";

export const getParserFixture = (name: string) => {
  const fixture = AGENT_OUTPUT_PARSER_FIXTURES.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing parser fixture ${name}`);
  return fixture;
};
