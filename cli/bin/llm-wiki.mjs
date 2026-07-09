#!/usr/bin/env node
import { program } from 'commander'
import { initKb } from '../src/init.mjs'

program.name('llm-wiki').description('Compile messy directories into an llm_wiki knowledge base')

program.command('init [dir]').description('scaffold a knowledge base').action((dir = '.') => {
  const { created, skipped } = initKb(dir)
  console.log(`created ${created.length} entries, skipped ${skipped.length} existing`)
})

program.parseAsync()
