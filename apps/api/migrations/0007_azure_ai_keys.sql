-- Lets an installation's own AI key be one for Azure AI Foundry or Azure OpenAI.
--
-- A customer names their Azure resource; the service builds the address from the name. See
-- docs/DESIGN-AI-KEYS.md, section 4.

ALTER TABLE installation_ai_keys
  -- Only for Azure: the resource's name, which becomes the first label of the host.
  ADD COLUMN resource text,
  DROP CONSTRAINT installation_ai_keys_provider_check,
  ADD CONSTRAINT installation_ai_keys_provider_check
    CHECK (provider IN ('anthropic', 'openai', 'bedrock', 'azure')),
  ADD CONSTRAINT installation_ai_keys_resource_check
    CHECK ((provider = 'azure') = (resource IS NOT NULL));
