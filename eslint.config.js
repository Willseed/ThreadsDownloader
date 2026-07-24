import eslint from '@eslint/js';
import angular from '@angular-eslint/eslint-plugin';
import angularTemplate from '@angular-eslint/eslint-plugin-template';
import angularTemplateParser from '@angular-eslint/template-parser';
import tseslint from 'typescript-eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.angular/**',
      '**/.wrangler/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    files: ['apps/web/**/*.ts'],
    plugins: { '@angular-eslint': angular },
    processor: angularTemplate.processors['extract-inline-html'],
    rules: {
      '@angular-eslint/component-class-suffix': 'error',
      '@angular-eslint/prefer-on-push-component-change-detection': 'error',
    },
  },
  {
    files: ['apps/web/**/*.html'],
    plugins: { '@angular-eslint/template': angularTemplate },
    languageOptions: { parser: angularTemplateParser },
    rules: {
      '@angular-eslint/template/eqeqeq': 'error',
    },
  },
  prettier,
);
