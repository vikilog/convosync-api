import tseslint from 'typescript-eslint';

// ponytail: recommended (not type-aware) so lint stays a gate, not a 10k-warning backlog.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      // ponytail: pre-existing unused/any/prefer-const noise; keep recommended otherwise.
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      'prefer-const': 'off',
    },
  },
);
