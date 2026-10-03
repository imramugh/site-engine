import type { ReactNode } from 'react'
import config from '@payload-config'
import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import { importMap } from './admin/importMap'

export default function Layout({ children }: { children: ReactNode }) {
  return RootLayout({
    children,
    config,
    importMap,
    serverFunction: async (args) => {
      'use server'
      return handleServerFunctions({ ...args, config, importMap })
    },
  })
}
