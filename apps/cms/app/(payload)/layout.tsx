import type { ReactNode } from 'react'
import '@payloadcms/next/css'
import './admin/admin-payload-shell.css'
import config from '@payload-config'
import { handleServerFunctions, RootLayout } from '@payloadcms/next/layouts'
import { importMap } from './admin/importMap.js'
import { AdminNavigationClientRuntime } from '../components/admin-navigation-toggle'

export default function Layout({ children }: { children: ReactNode }) {
  return RootLayout({
    children: <><AdminNavigationClientRuntime />{children}</>,
    config,
    importMap,
    serverFunction: async (args) => {
      'use server'
      return handleServerFunctions({ ...args, config, importMap })
    },
  })
}
