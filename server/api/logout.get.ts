export default eventHandler(() => {
  throw createError({ statusCode: 405, message: 'Use POST to log out' })
})
